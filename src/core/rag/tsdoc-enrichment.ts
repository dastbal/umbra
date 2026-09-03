import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { NestChunker } from '../tools/ast/chunker';
import { ChunkMetadata, ProcessedChunk } from '../types';

const TSDOC_ENRICHMENT_KEY = 'tsdoc-enrichment-v1';

/**
 * Backfills only TSDoc metadata for existing chunks. It never changes chunk
 * identity, code text, or vectors, so it is safe before either embedding
 * provider has been authorized for another run.
 *
 * @param db - Umbra's SQLite database.
 * @param rootDir - Repository root containing indexed relative paths.
 * @returns Number of chunk metadata rows changed.
 */
export function enrichExistingTSDoc(db: Database.Database, rootDir: string): number {
  db.exec(`CREATE TABLE IF NOT EXISTS rag_metadata_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  if (db.prepare(`SELECT 1 FROM rag_metadata_state WHERE key = ?`).get(TSDOC_ENRICHMENT_KEY)) {
    return 0;
  }

  const rows = db.prepare(
    `SELECT id, file_path, chunk_type, metadata FROM code_chunks ORDER BY file_path, id`,
  ).all() as { id: string; file_path: string; chunk_type: string; metadata: string }[];
  const byPath = new Map<string, typeof rows>();
  for (const row of rows) {
    const group = byPath.get(row.file_path) ?? [];
    group.push(row);
    byPath.set(row.file_path, group);
  }

  const chunker = new NestChunker();
  const resolvedRoot = path.resolve(rootDir);
  const update = db.prepare(`UPDATE code_chunks SET metadata = ? WHERE id = ?`);
  let changed = 0;
  const apply = db.transaction(() => {
    for (const [filePath, stored] of byPath) {
      if (!filePath.endsWith('.ts')) continue;
      const absolutePath = path.resolve(resolvedRoot, filePath);
      const relativeToRoot = path.relative(resolvedRoot, absolutePath);
      if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot) || !fs.existsSync(absolutePath)) continue;
      const content = fs.readFileSync(absolutePath, 'utf8');
      const generated = chunker.analyze(filePath, content, '').chunks;
      for (const row of stored) {
        const original = parseMetadata(row.metadata);
        const source = generated.find((chunk) => sameChunk(chunk, row.chunk_type, original));
        if (source?.metadata.documentation === undefined || original.documentation === source.metadata.documentation) {
          continue;
        }
        update.run(JSON.stringify({ ...original, documentation: source.metadata.documentation }), row.id);
        changed++;
      }
    }
    db.prepare(`INSERT INTO rag_metadata_state (key, value) VALUES (?, ?)`).run(
      TSDOC_ENRICHMENT_KEY,
      String(Date.now()),
    );
  });
  apply();
  return changed;
}

function sameChunk(chunk: ProcessedChunk, chunkType: string, metadata: ChunkMetadata): boolean {
  return chunk.type === chunkType &&
    chunk.metadata.startLine === metadata.startLine &&
    chunk.metadata.endLine === metadata.endLine &&
    chunk.metadata.className === metadata.className &&
    chunk.metadata.methodName === metadata.methodName;
}

function parseMetadata(value: string): ChunkMetadata {
  try {
    return JSON.parse(value) as ChunkMetadata;
  } catch {
    return { startLine: 0, endLine: 0 };
  }
}
