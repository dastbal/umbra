import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { enrichExistingTSDoc } from './tsdoc-enrichment';
import { ensureLexicalIndex, findLexicalCandidates } from './lexical-index';

describe('TSDoc enrichment', () => {
  let db: Database.Database;
  let root: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE file_registry (path TEXT PRIMARY KEY, hash TEXT NOT NULL, last_indexed INTEGER NOT NULL, skeleton_signature TEXT);
      CREATE TABLE code_chunks (
        id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        chunk_type TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT,
        FOREIGN KEY(file_path) REFERENCES file_registry(path) ON DELETE CASCADE
      );
      INSERT INTO file_registry VALUES ('src/sample.service.ts', 'x', 1, NULL);
      INSERT INTO code_chunks VALUES (
        'method-1', 'src/sample.service.ts', 'method', 'find() { return true; }',
        '{"startLine":5,"endLine":5,"className":"SampleService","methodName":"find"}'
      );
    `);
    ensureLexicalIndex(db);
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-tsdoc-'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'sample.service.ts'), [
      'export class SampleService {',
      '  /**',
      '   * Finds the payment by its policy number.',
      '   */',
      '  find() { return true; }',
      '}',
    ].join('\n'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('adds TSDoc to matching metadata once and lets FTS retrieve it', () => {
    expect(enrichExistingTSDoc(db, root)).toBe(1);
    expect(enrichExistingTSDoc(db, root)).toBe(0);

    const row = db.prepare(`SELECT metadata FROM code_chunks WHERE id = 'method-1'`).get() as {
      metadata: string;
    };
    expect(row.metadata).toContain('Finds the payment by its policy number.');
    expect(findLexicalCandidates(db, 'policy number', 4)[0]?.chunkId).toBe('method-1');
  });
});
