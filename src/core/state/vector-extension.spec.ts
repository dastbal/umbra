import Database from 'better-sqlite3';
import { loadVectorExtension, resetVectorExtension } from './vector-extension';
import { encodeVector } from '../rag/vector-codec';
import { cosineSimilarity } from '../rag/math';
import { resetLogSink, setLogSink } from '../observability/console-sink';

/**
 * Pins the contract between SQL-side and JavaScript-side ranking.
 *
 * The two paths must agree, because which one runs depends on whether a native
 * binary happened to load. A sign error or a similarity/distance mix-up would
 * produce a ranking that is confidently reversed on one platform and correct on
 * another — the worst possible shape for a bug in this subsystem.
 */
describe('vector extension', () => {
  let db: Database.Database;

  beforeEach(() => {
    resetVectorExtension();
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
    resetVectorExtension();
    resetLogSink();
  });

  it('loads and reports its version', () => {
    const status = loadVectorExtension(db);

    // If this fails on a platform sqlite-vec does not publish for, the
    // retriever must still work; see the fallback assertions below.
    expect(status.available).toBe(true);
    expect(status.version).toMatch(/^v?\d+\.\d+\.\d+/);
  });

  it('memoizes, so a failure is not reported once per query', () => {
    const first = loadVectorExtension(db);
    const second = loadVectorExtension(db);

    expect(second).toBe(first);
  });

  it('reports a load failure rather than falling back silently', () => {
    // A silent fallback would hide an order-of-magnitude performance
    // difference behind identical-looking results.
    const lines: string[] = [];
    setLogSink((line) => lines.push(line));

    const closed = new Database(':memory:');
    closed.close();
    const status = loadVectorExtension(closed);

    expect(status.available).toBe(false);
    expect(status.reason).toBeDefined();
    expect(lines.join('\n')).toContain('sqlite-vec');
  });

  describe('SQL and JavaScript ranking agree', () => {
    /** Builds a tiny vector table with three known vectors. */
    function seed(): void {
      db.exec(`CREATE TABLE v (id TEXT PRIMARY KEY, vector BLOB NOT NULL)`);
      const insert = db.prepare('INSERT INTO v VALUES (?, ?)');
      insert.run('same', encodeVector([1, 0, 0]));
      insert.run('near', encodeVector([0.9, 0.1, 0]));
      insert.run('far', encodeVector([0, 0, 1]));
    }

    it('produces the same order, and the same score after 1 - distance', () => {
      const status = loadVectorExtension(db);
      if (!status.available) {
        // Nothing to compare on a platform without the extension. Reported so a
        // green run on such a platform is not mistaken for a verified one.
        expect(status.reason).toBeDefined();
        return;
      }

      seed();
      const query = [1, 0, 0];

      const fromSql = db
        .prepare(
          `SELECT id, vec_distance_cosine(vector, ?) AS distance
             FROM v ORDER BY distance`,
        )
        .all(encodeVector(query)) as { id: string; distance: number }[];

      const fromJs = (
        db.prepare('SELECT id, vector FROM v').all() as { id: string; vector: Buffer }[]
      )
        .map((row) => ({
          id: row.id,
          score: cosineSimilarity(
            query,
            new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4),
          ),
        }))
        .sort((a, b) => b.score - a.score);

      expect(fromSql.map((r) => r.id)).toEqual(['same', 'near', 'far']);
      expect(fromSql.map((r) => r.id)).toEqual(fromJs.map((r) => r.id));

      // The retriever reports `1 - distance` as the score. If that conversion
      // were wrong, the ranking would still look plausible while every reported
      // relevance was inverted.
      fromSql.forEach((sqlRow, i) => {
        expect(1 - sqlRow.distance).toBeCloseTo(fromJs[i]!.score, 5);
      });
    });

    it('returns only the requested rows, which is the memory argument', () => {
      const status = loadVectorExtension(db);
      if (!status.available) return;

      seed();
      const rows = db
        .prepare(
          `SELECT id, vec_distance_cosine(vector, ?) AS distance
             FROM v ORDER BY distance LIMIT 1`,
        )
        .all(encodeVector([1, 0, 0]));

      // Three vectors were compared; one crossed into JavaScript. On a
      // 50,000-chunk repository that difference is 146 MB per query.
      expect(rows).toHaveLength(1);
    });
  });
});
