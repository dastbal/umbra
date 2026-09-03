import Database from 'better-sqlite3';

/**
 * Locks the invariant that ADR-025 promises and that the first implementation
 * broke: **writing one provider's vector must never clear another's.**
 *
 * These are SQL-level assertions on a throwaway database rather than tests of
 * `IndexerService`, because the defect lived in the SQL and in the schema, not
 * in the orchestration. A live cross-provider run on this repository measured
 * the damage: `vector_json` fell from 232 rows to 5, `vector_vertex_json` from
 * 45 to 0, while Ollama wrote 252. The Vertex index was gone, and every unit
 * test passed throughout — they inject a port and never touch the storage path.
 *
 * Two mechanisms combined to cause it, and both are pinned below so neither can
 * return quietly.
 */
describe('vector column coexistence', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
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
        vector_json TEXT,
        metadata TEXT,
        vector_vertex_json TEXT,
        vector_ollama_json TEXT,
        FOREIGN KEY(file_path) REFERENCES file_registry(path) ON DELETE CASCADE
      );
      INSERT INTO file_registry VALUES ('src/a.ts', 'hash-1', 1, NULL);
      INSERT INTO code_chunks (id, file_path, chunk_type, content, vector_vertex_json)
        VALUES ('chunk-1', 'src/a.ts', 'method', 'class A {}', '[0.1,0.2]');
    `);
  });

  afterEach(() => {
    db.close();
  });

  /** @returns How many rows hold a non-null value in `column`. */
  function count(column: string): number {
    return (
      db.prepare(`SELECT COUNT(*) n FROM code_chunks WHERE ${column} IS NOT NULL`).get() as {
        n: number;
      }
    ).n;
  }

  it('enforces foreign keys, which is why the cascade below is not theoretical', () => {
    // better-sqlite3 turns `PRAGMA foreign_keys` on by default, unlike the
    // sqlite3 CLI. The cascade is live in production.
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('fills the second provider without disturbing the first', () => {
    db.prepare(`UPDATE code_chunks SET vector_ollama_json = ? WHERE id = ?`).run(
      '[0.3,0.4]',
      'chunk-1',
    );

    expect(count('vector_vertex_json')).toBe(1);
    expect(count('vector_ollama_json')).toBe(1);

    const row = db.prepare('SELECT * FROM code_chunks WHERE id = ?').get('chunk-1') as Record<
      string,
      unknown
    >;
    // The point of the whole design: one row, two vector spaces, neither
    // reachable from the other's query.
    expect(row.vector_vertex_json).toBe('[0.1,0.2]');
    expect(row.vector_ollama_json).toBe('[0.3,0.4]');
  });

  describe('cause 1 — INSERT OR REPLACE on the parent cascade-deletes the chunks', () => {
    it('destroys every chunk of the file, which is what wiped the Vertex index', () => {
      // `FileRegistry#updateFile` issues exactly this statement, under a comment
      // that calls it an UPSERT. It is not one: REPLACE deletes the row first,
      // and ON DELETE CASCADE takes the children with it.
      db.prepare(
        `INSERT OR REPLACE INTO file_registry (path, hash, last_indexed, skeleton_signature)
         VALUES (?, ?, ?, ?)`,
      ).run('src/a.ts', 'hash-2', 2, null);

      expect(count('vector_vertex_json')).toBe(0);
    });

    it('leaves the chunks alone when the parent is updated with a real upsert', () => {
      db.prepare(
        `INSERT INTO file_registry (path, hash, last_indexed, skeleton_signature)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET hash = excluded.hash, last_indexed = excluded.last_indexed`,
      ).run('src/a.ts', 'hash-2', 2, null);

      expect(count('vector_vertex_json')).toBe(1);
    });

    it('is deliberately left in place, because on a content change it is correct', () => {
      // When a file's text really changed, its old chunks are stale for *every*
      // provider and removing them is right. The bug was re-running this on a
      // provider switch, where nothing had changed. `isFileChanged` gates it.
      db.prepare(
        `INSERT OR REPLACE INTO file_registry (path, hash, last_indexed, skeleton_signature)
         VALUES (?, ?, ?, ?)`,
      ).run('src/a.ts', 'hash-2', 2, null);

      expect(count('vector_ollama_json')).toBe(0);
      expect(count('vector_vertex_json')).toBe(0);
    });
  });

  describe('cause 2 — INSERT OR REPLACE on a chunk blanks the other provider column', () => {
    it('loses the first provider vector when the row is replaced', () => {
      // The original `embedAndSaveBatches` used this. REPLACE deletes and
      // reinserts, so every column absent from the VALUES list comes back NULL.
      db.prepare(
        `INSERT OR REPLACE INTO code_chunks (id, file_path, chunk_type, content, vector_ollama_json, metadata)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('chunk-1', 'src/a.ts', 'method', 'class A {}', '[0.3,0.4]', '{}');

      expect(count('vector_ollama_json')).toBe(1);
      expect(count('vector_vertex_json')).toBe(0);
    });

    it('preserves it under the upsert the indexer now uses', () => {
      db.prepare(
        `INSERT INTO code_chunks (id, file_path, chunk_type, content, vector_ollama_json, metadata)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           file_path = excluded.file_path,
           chunk_type = excluded.chunk_type,
           content = excluded.content,
           metadata = excluded.metadata,
           vector_ollama_json = excluded.vector_ollama_json`,
      ).run('chunk-1', 'src/a.ts', 'method', 'class A {}', '[0.3,0.4]', '{}');

      expect(count('vector_ollama_json')).toBe(1);
      expect(count('vector_vertex_json')).toBe(1);
    });
  });

  describe('the backfill path — a provider switch is not a content change', () => {
    it('fills only the empty column, in place, for chunks that already exist', () => {
      // This is what `backfillMissingVectors` does: no re-chunk, no new ids, no
      // parent write, therefore no cascade and nothing to lose.
      const pending = db
        .prepare(
          `SELECT id, content FROM code_chunks WHERE vector_ollama_json IS NULL AND content IS NOT NULL`,
        )
        .all() as { id: string; content: string }[];

      expect(pending).toHaveLength(1);

      db.prepare(`UPDATE code_chunks SET vector_ollama_json = ? WHERE id = ?`).run(
        '[0.3,0.4]',
        pending[0]!.id,
      );

      expect(count('vector_vertex_json')).toBe(1);
      expect(count('vector_ollama_json')).toBe(1);
      expect(
        (db.prepare('SELECT COUNT(*) n FROM code_chunks').get() as { n: number }).n,
      ).toBe(1);
    });

    it('selects nothing once the provider already has every vector', () => {
      db.prepare(`UPDATE code_chunks SET vector_ollama_json = ?`).run('[0.3,0.4]');

      const pending = db
        .prepare(`SELECT id FROM code_chunks WHERE vector_ollama_json IS NULL`)
        .all();

      // Switching back is free: there is nothing to embed and nothing to pay.
      expect(pending).toHaveLength(0);
    });
  });
});
