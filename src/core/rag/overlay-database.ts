import Database from 'better-sqlite3';
import { loadVectorExtensionInto } from '../state/vector-extension';
import type { WorktreeOverlay } from './worktree-overlay';
import { commitGraphOnlyFile, commitIndexedFile, commitSkippedFile } from './indexed-file-rows';
import type { EmbeddingsIdentity } from './embeddings/embeddings.port';

/** Tables read by retrieval and graph tools through the merged worktree view. */
const VIEW_TABLES: ReadonlyArray<{ name: string; path: string }> = [
  { name: 'file_registry', path: 'path' },
  { name: 'code_chunks', path: 'file_path' },
  { name: 'dependency_graph', path: 'source' },
  { name: 'dependency_scan', path: 'file_path' },
  { name: 'nest_bindings', path: 'file_path' },
  { name: 'nest_injections', path: 'file_path' },
  { name: 'nest_scan', path: 'file_path' },
];

/** Opens a disposable in-memory writer with the durable index attached for reads. */
export function openOverlayDatabase(dbPath: string, timeout: number): { db: Database.Database; vectorSearchAvailable: boolean } {
  const db = new Database(':memory:', { timeout });
  try {
    db.prepare('ATTACH DATABASE ? AS base').run(dbPath);
    const tables = [
      'file_registry', 'code_chunks', 'chunk_vectors', 'dependency_graph', 'dependency_scan',
      'nest_bindings', 'nest_injections', 'nest_scan', 'code_chunks_fts',
    ];
    for (const name of tables) {
      const row = db.prepare("SELECT sql FROM base.sqlite_master WHERE type = 'table' AND name = ?").get(name) as { sql: string } | undefined;
      if (row !== undefined) db.exec(row.sql);
    }
    const triggers = db.prepare("SELECT sql FROM base.sqlite_master WHERE type = 'trigger' AND name LIKE 'code_chunks_fts_%'").all() as { sql: string }[];
    for (const trigger of triggers) db.exec(trigger.sql);
    db.exec('CREATE TABLE hidden_paths (path TEXT PRIMARY KEY)');
    db.pragma('foreign_keys = ON');
    return { db, vectorSearchAvailable: loadVectorExtensionInto(db) };
  } catch (error: unknown) {
    db.close();
    throw error;
  }
}

/** Writes only to the connection's memory database, then shadows read tables with merged views. */
export function installOverlayView(db: Database.Database, overlay: WorktreeOverlay, identity: EmbeddingsIdentity): void {
  const hidden = [...new Set([...overlay.files.map((file) => file.analyzed.relativePath), ...overlay.delta.deleted])];
  const insertHidden = db.prepare('INSERT INTO main.hidden_paths (path) VALUES (?)');
  for (const file of hidden) insertHidden.run(file);
  for (const file of overlay.files) {
    if (file.analyzed.chunks.length === 0) {
      commitSkippedFile(db, file.analyzed, file.analyzed.skeleton, 'empty-or-whitespace source in worktree');
    } else if (file.vectors === undefined) {
      commitGraphOnlyFile(db, file.analyzed);
    } else {
      commitIndexedFile(db, identity, file.analyzed, file.vectors);
    }
  }
  for (const { name, path } of VIEW_TABLES) {
    const exists = db.prepare("SELECT 1 FROM base.sqlite_master WHERE type = 'table' AND name = ?").get(name);
    if (exists === undefined) continue;
    db.exec(`CREATE TEMP VIEW ${name} AS
      SELECT * FROM base.${name} WHERE ${path} NOT IN (SELECT path FROM main.hidden_paths)
      UNION ALL SELECT * FROM main.${name}`);
  }
  db.exec(`CREATE TEMP VIEW chunk_vectors AS
    SELECT v.* FROM base.chunk_vectors v
      WHERE NOT EXISTS (
        SELECT 1 FROM base.code_chunks c JOIN main.hidden_paths h ON h.path = c.file_path
        WHERE c.id = v.chunk_id
      )
    UNION ALL SELECT * FROM main.chunk_vectors`);
}

/** Whether this connection holds an attached durable base and a worktree's in-memory rows. */
export function isOverlayDatabase(db: Database.Database): boolean {
  return (db.pragma('database_list') as Array<{ name: string }>).some((database) => database.name === 'base');
}
