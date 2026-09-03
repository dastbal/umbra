import Database from 'better-sqlite3';
import {
  ensureLexicalIndex,
  findLexicalCandidates,
  hasExactLexicalEvidence,
  toLexicalMatchExpression,
} from './lexical-index';

/**
 * Exercises the lexical index at SQLite level, where the foreign-key cascade
 * and its triggers actually execute.
 */
describe('lexical code index', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE file_registry (
        path TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        last_indexed INTEGER NOT NULL,
        skeleton_signature TEXT
      );
      CREATE TABLE code_chunks (
        id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        chunk_type TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT,
        FOREIGN KEY(file_path) REFERENCES file_registry(path) ON DELETE CASCADE
      );
      INSERT INTO file_registry VALUES ('src/rag/retriever.ts', 'first', 1, NULL);
      INSERT INTO code_chunks VALUES (
        'existing', 'src/rag/retriever.ts', 'method',
        'export function retrieveCode() { return query; }',
        '{"className":"RetrieverService","methodName":"query"}'
      );
    `);
  });

  afterEach(() => db.close());

  /** @returns The number of indexed lexical rows. */
  function indexedRows(): number {
    return (db.prepare('SELECT COUNT(*) AS count FROM code_chunks_fts').get() as { count: number })
      .count;
  }

  it('backfills existing chunks once and makes them searchable', () => {
    ensureLexicalIndex(db);
    ensureLexicalIndex(db);

    expect(indexedRows()).toBe(1);
    expect(findLexicalCandidates(db, 'Where is RetrieverService query?', 12)).toEqual([
      expect.objectContaining({ chunkId: 'existing' }),
    ]);
  });

  it('indexes a newly inserted chunk through its trigger', () => {
    ensureLexicalIndex(db);
    db.prepare(
      `INSERT INTO code_chunks VALUES (?, ?, ?, ?, ?)`,
    ).run(
      'new',
      'src/rag/retriever.ts',
      'method',
      'export function pinProvider() {}',
      '{"methodName":"pinProvider"}',
    );

    expect(findLexicalCandidates(db, 'pinProvider', 12)[0]?.chunkId).toBe('new');
  });

  it('replaces lexical text on a chunk update', () => {
    ensureLexicalIndex(db);
    db.prepare(`UPDATE code_chunks SET content = ? WHERE id = ?`).run(
      'export function groundedEvidence() {}',
      'existing',
    );

    expect(findLexicalCandidates(db, 'retrieveCode', 12)).toEqual([]);
    expect(findLexicalCandidates(db, 'groundedEvidence', 12)[0]?.chunkId).toBe('existing');
  });

  it('removes lexical text when a file cascade deletes its chunks', () => {
    ensureLexicalIndex(db);
    db.prepare(
      `INSERT OR REPLACE INTO file_registry (path, hash, last_indexed, skeleton_signature)
       VALUES (?, ?, ?, ?)`,
    ).run('src/rag/retriever.ts', 'changed', 2, null);

    expect(indexedRows()).toBe(0);
    expect(findLexicalCandidates(db, 'RetrieverService', 12)).toEqual([]);
  });

  it('turns punctuation into data instead of executable FTS syntax', () => {
    ensureLexicalIndex(db);
    const expression = toLexicalMatchExpression('" OR * NEAR / retriever.ts');

    expect(expression).toBe('"or" OR "near" OR "retriever" OR "ts"');
    expect(() => findLexicalCandidates(db, '" OR * NEAR / retriever.ts', 12)).not.toThrow();
  });

  it('accepts direct path or metadata evidence, not a content-only hit', () => {
    expect(
      hasExactLexicalEvidence(
        'Where is RetrieverService defined?',
        'src/rag/retriever.ts',
        '{"className":"RetrieverService"}',
      ),
    ).toBe(true);
    expect(
      hasExactLexicalEvidence(
        'Where is Saturn payroll configured?',
        'src/rag/retriever.ts',
        '{"className":"RetrieverService"}',
      ),
    ).toBe(false);
  });
});
