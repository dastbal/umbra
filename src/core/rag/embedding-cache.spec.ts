import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EmbeddingCache, ensureEmbeddingCacheSchema } from './embedding-cache';
import type { EmbeddingsIdentity } from './embeddings/embeddings.port';

const identity: EmbeddingsIdentity = { provider: 'ollama', model: 'test-model', dimensions: 3, column: 'vector_ollama_json' };

describe('EmbeddingCache', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    ensureEmbeddingCacheSchema(db);
  });

  afterEach(() => db.close());

  it('reuses exact input across cache instances and separates dimensions', () => {
    new EmbeddingCache(db).put(identity, ['Class: Foo\nsource'], [[1, 2, 3]]);
    expect(new EmbeddingCache(db).get(identity, ['Class: Foo\nsource']).get('Class: Foo\nsource'))
      .toEqual([1, 2, 3]);
    expect(new EmbeddingCache(db).get({ ...identity, dimensions: 4 }, ['Class: Foo\nsource']).size)
      .toBe(0);
    expect(new EmbeddingCache(db).get({ ...identity, model: 'other' }, ['Class: Foo\nsource']).size)
      .toBe(0);
  });

  it('survives a closed database connection', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-vector-cache-'));
    const filename = path.join(directory, 'memory.db');
    try {
      const writer = new Database(filename);
      ensureEmbeddingCacheSchema(writer);
      new EmbeddingCache(writer).put(identity, ['exact input'], [[1, 2, 3]]);
      writer.close();
      const reader = new Database(filename);
      expect(new EmbeddingCache(reader).get(identity, ['exact input']).get('exact input')).toEqual([1, 2, 3]);
      reader.close();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects vectors with the wrong dimensions', () => {
    expect(() => new EmbeddingCache(db).put(identity, ['input'], [[1, 2]])).toThrow(/dimensions/);
  });

  it('evicts the oldest vector when the row limit is reached', () => {
    const cache = new EmbeddingCache(db, 2);
    cache.put(identity, ['old', 'middle'], [[1, 0, 0], [0, 1, 0]]);
    cache.put(identity, ['new'], [[0, 0, 1]]);
    expect(cache.get(identity, ['old', 'middle', 'new']).has('old')).toBe(false);
    expect(cache.get(identity, ['middle', 'new']).size).toBe(2);
  });
});
