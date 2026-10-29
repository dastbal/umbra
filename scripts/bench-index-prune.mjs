#!/usr/bin/env node
/** Compare the 2.4.1 per-path cleanup with the atomic cleanup on identical SQLite copies. */
import { createRequire } from 'module';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { performance } from 'perf_hooks';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { pruneObsoleteIndexPaths } = require('../dist/core/rag/index-prune.js');
const argument = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at < 0 ? fallback : process.argv[at + 1];
};
const rows = Number(argument('--rows', '12000'));
const obsolete = Number(argument('--obsolete', '100'));
const repeats = Number(argument('--repeats', '5'));
const output = argument('--output', '');
const sourceDb = argument('--source-db', '');
if (!Number.isInteger(rows) || !Number.isInteger(obsolete) || !Number.isInteger(repeats)
  || rows < 2 || obsolete < 1 || repeats < 1 || repeats > 10 || (sourceDb === '' && obsolete >= rows)) {
  throw new Error('Use integer --rows, --obsolete and --repeats values with 0 < obsolete < rows and 1 <= repeats <= 10.');
}

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-prune-bench-'));
try {
  const template = path.join(directory, 'template.db');
  if (sourceDb !== '') {
    const source = new Database(sourceDb, { readonly: true, fileMustExist: true });
    try { await source.backup(template); } finally { source.close(); }
  }
  const db = new Database(template);
  db.pragma('foreign_keys = ON');
  if (sourceDb === '') {
    db.exec(`
    CREATE TABLE file_registry (path TEXT PRIMARY KEY);
    CREATE TABLE code_chunks (
      id TEXT PRIMARY KEY, file_path TEXT NOT NULL, content TEXT NOT NULL,
      FOREIGN KEY(file_path) REFERENCES file_registry(path) ON DELETE CASCADE
    );
    CREATE VIRTUAL TABLE code_chunks_fts USING fts5(chunk_id UNINDEXED, file_path, metadata, content);
    CREATE TRIGGER code_chunks_fts_insert AFTER INSERT ON code_chunks BEGIN
      INSERT INTO code_chunks_fts VALUES (NEW.id, NEW.file_path, '', NEW.content);
    END;
    CREATE TRIGGER code_chunks_fts_delete AFTER DELETE ON code_chunks BEGIN
      DELETE FROM code_chunks_fts WHERE chunk_id = OLD.id;
    END;
  `);
    const insertPath = db.prepare('INSERT INTO file_registry (path) VALUES (?)');
    const insertChunk = db.prepare('INSERT INTO code_chunks (id, file_path, content) VALUES (?, ?, ?)');
    db.transaction(() => {
      for (let index = 0; index < rows; index += 1) {
        const file = `src/file-${String(index).padStart(6, '0')}.ts`;
        insertPath.run(file);
        insertChunk.run(`chunk-${index}`, file, `export function code${index}() { return 'payment retry'; }`);
      }
    })();
  }
  const sqliteVersion = db.prepare('SELECT sqlite_version() AS version').get().version;
  const initial = {
    files: db.prepare('SELECT COUNT(*) AS total FROM file_registry').get().total,
    chunks: db.prepare('SELECT COUNT(*) AS total FROM code_chunks').get().total,
    fts: db.prepare('SELECT COUNT(*) AS total FROM code_chunks_fts').get().total,
  };
  const paths = sourceDb === ''
    ? Array.from({ length: obsolete }, (_, offset) =>
      `src/file-${String(rows - obsolete + offset).padStart(6, '0')}.ts`)
    : db.prepare(`SELECT f.path FROM file_registry f JOIN code_chunks c ON c.file_path = f.path
        GROUP BY f.path ORDER BY COUNT(*) DESC, f.path LIMIT ?`).all(obsolete).map((row) => row.path);
  if (paths.length !== obsolete) throw new Error(`Only ${paths.length} paths could be selected for pruning.`);
  const selected = db.prepare('CREATE TEMP TABLE selected_prune_paths (path TEXT PRIMARY KEY)');
  selected.run();
  const selectPath = db.prepare('INSERT INTO temp.selected_prune_paths VALUES (?)');
  for (const file of paths) selectPath.run(file);
  const removedChunks = db.prepare(`SELECT COUNT(*) AS total FROM code_chunks
    WHERE file_path IN (SELECT path FROM temp.selected_prune_paths)`).get().total;
  const expected = { files: initial.files - obsolete, chunks: initial.chunks - removedChunks, fts: initial.fts - removedChunks };
  db.close();

  const run = (name, cleanup, iteration) => {
    const filename = path.join(directory, `${name}-${iteration}.db`);
    fs.copyFileSync(template, filename);
    const connection = new Database(filename);
    connection.pragma('foreign_keys = ON');
    const started = performance.now();
    cleanup(connection, paths);
    const elapsedMs = performance.now() - started;
    const count = (table) => connection.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get().total;
    const remaining = { files: count('file_registry'), chunks: count('code_chunks'), fts: count('code_chunks_fts') };
    const triggerPresent = connection.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'code_chunks_fts_delete'").get() !== undefined;
    connection.close();
    if (Object.entries(remaining).some(([table, value]) => value !== expected[table]) || !triggerPresent) {
      throw new Error(`${name} left inconsistent rows or trigger: ${JSON.stringify({ remaining, triggerPresent })}`);
    }
    return { elapsedMs: Number(elapsedMs.toFixed(3)), remaining };
  };
  const perPath = (connection, selected) => {
    const remove = connection.prepare('DELETE FROM file_registry WHERE path = ?');
    for (const file of selected) remove.run(file);
  };
  const beforeRuns = [];
  const afterRuns = [];
  for (let iteration = 0; iteration < repeats; iteration += 1) {
    if (iteration % 2 === 0) {
      beforeRuns.push(run('per-path', perPath, iteration));
      afterRuns.push(run('atomic', pruneObsoleteIndexPaths, iteration));
    } else {
      afterRuns.push(run('atomic', pruneObsoleteIndexPaths, iteration));
      beforeRuns.push(run('per-path', perPath, iteration));
    }
  }
  const summarize = (runs) => ({
    medianMs: [...runs.map((run) => run.elapsedMs)].sort((left, right) => left - right)[Math.floor(runs.length / 2)],
    samplesMs: runs.map((run) => run.elapsedMs),
    remaining: runs[0].remaining,
  });
  const before = summarize(beforeRuns);
  const after = summarize(afterRuns);
  const report = {
    source: sourceDb === '' ? 'synthetic' : 'snapshot of a local index',
    initial, obsoletePaths: obsolete, removedChunks, repeats, node: process.version, sqliteVersion,
    before, after, speedup: Number((before.medianMs / after.medianMs).toFixed(2)),
    scope: 'SQLite cleanup only; excludes discovery, embeddings and MCP. Source database is never modified.',
  };
  if (output) fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
