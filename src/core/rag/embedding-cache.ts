import * as crypto from 'crypto';
import type Database from 'better-sqlite3';
import type { EmbeddingsIdentity } from './embeddings/embeddings.port';
import { decodeVector, encodeVector } from './vector-codec';

/** Maximum persisted vectors per repository, about 150 MiB at 768 dimensions. */
const MAX_CACHE_ROWS = 50_000;

/** Creates the shared content cache without changing the chunk vector schema. */
export function ensureEmbeddingCacheSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS embedding_cache (
      id INTEGER PRIMARY KEY,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      input_hash TEXT NOT NULL,
      vector BLOB NOT NULL,
      UNIQUE(provider, model, dimensions, input_hash)
    );
  `);
}

/** Shares vectors for identical embedding inputs across files, worktrees and processes. */
export class EmbeddingCache {
  /**
   * @param db - The repository's index connection.
   * @param maxRows - Maximum stored vectors; injectable for eviction tests.
   */
  public constructor(private readonly db: Database.Database, private readonly maxRows = MAX_CACHE_ROWS) {}

  /** Returns only vectors matching both the exact input and full embedding identity. */
  public get(identity: EmbeddingsIdentity, inputs: readonly string[]): Map<string, number[]> {
    const vectors = new Map<string, number[]>();
    const find = this.db.prepare(`
      SELECT vector FROM embedding_cache
      WHERE provider = ? AND model = ? AND dimensions = ? AND input_hash = ?
    `);
    for (const input of inputs) {
      const row = find.get(identity.provider, identity.model, identity.dimensions, hashInput(input)) as
        | { vector: Buffer }
        | undefined;
      if (row === undefined) continue;
      const vector = decodeVector(row.vector);
      if (vector.length === identity.dimensions) vectors.set(input, Array.from(vector));
    }
    return vectors;
  }

  /** Stores provider results and evicts oldest rows once the cache exceeds its bound. */
  public put(identity: EmbeddingsIdentity, inputs: readonly string[], vectors: readonly (readonly number[])[]): void {
    if (inputs.length !== vectors.length) throw new Error('Embedding cache input and vector counts differ.');
    for (const vector of vectors) {
      if (vector.length !== identity.dimensions) throw new Error('Embedding cache vector dimensions do not match the provider identity.');
    }
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO embedding_cache (provider, model, dimensions, input_hash, vector)
      VALUES (?, ?, ?, ?, ?)
    `);
    this.db.transaction(() => {
      inputs.forEach((input, index) => {
        insert.run(identity.provider, identity.model, identity.dimensions, hashInput(input), encodeVector(vectors[index]!));
      });
      const count = (this.db.prepare('SELECT COUNT(*) AS total FROM embedding_cache').get() as { total: number }).total;
      if (count > this.maxRows) {
        this.db.prepare(`
          DELETE FROM embedding_cache WHERE id IN (
            SELECT id FROM embedding_cache ORDER BY id LIMIT ?
          )
        `).run(count - this.maxRows);
      }
    })();
  }
}

/** Hashes the exact text sent to the provider; identity is a separate SQL key. */
function hashInput(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}
