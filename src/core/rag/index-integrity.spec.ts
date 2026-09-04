import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { inspectIndexIntegrity } from './index-integrity';

describe('inspectIndexIntegrity', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-index-integrity-'));
    const stateDir = path.join(rootDir, '.umbra');
    fs.mkdirSync(stateDir);
    const db = new Database(path.join(stateDir, 'memory.db'));
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE file_registry (path TEXT PRIMARY KEY, hash TEXT NOT NULL, last_indexed INTEGER NOT NULL, skeleton_signature TEXT);
      CREATE TABLE code_chunks (id TEXT PRIMARY KEY, file_path TEXT NOT NULL, chunk_type TEXT NOT NULL, content TEXT NOT NULL, metadata TEXT, FOREIGN KEY(file_path) REFERENCES file_registry(path));
      CREATE TABLE chunk_vectors (chunk_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, dimensions INTEGER NOT NULL, vector BLOB NOT NULL, PRIMARY KEY(chunk_id, provider, model), FOREIGN KEY(chunk_id) REFERENCES code_chunks(id));
      INSERT INTO file_registry VALUES ('src/a.ts', 'a', 1, NULL), ('src/b.ts', 'b', 1, NULL);
      INSERT INTO code_chunks VALUES ('a', 'src/a.ts', 'file', 'a', '{}'), ('b', 'src/b.ts', 'file', 'b', '{}');
      INSERT INTO chunk_vectors VALUES ('a', 'ollama', 'nomic-embed-text', 3, X'000000000000000000000000');
    `);
    db.close();
  });

  afterEach(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  it('reports registered files separately from missing vectors for the selected identity', () => {
    const report = inspectIndexIntegrity(rootDir, { provider: 'ollama', model: 'nomic-embed-text' });

    expect(report.files).toBe(2);
    expect(report.chunks).toBe(2);
    expect(report.missingVectors).toBe(1);
    expect(report.missingPaths).toEqual(['src/b.ts']);
    expect(report.healthy).toBe(false);
  });

  it('reports an absent workspace database as an invalid index instead of an empty valid one', () => {
    fs.rmSync(path.join(rootDir, '.umbra', 'memory.db'));
    const report = inspectIndexIntegrity(rootDir, { provider: 'ollama', model: 'nomic-embed-text' });

    expect(report.databaseExists).toBe(false);
    expect(report.healthy).toBe(false);
    expect(report.diagnostic).toMatch(/No .umbra\/memory.db/);
  });
});
