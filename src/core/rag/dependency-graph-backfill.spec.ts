import Database from 'better-sqlite3';
import { backfillDependencyGraph, type BackfillCandidate } from './dependency-graph-backfill';
import { GraphEdge } from '../types';

/** A registry plus the graph table, with the cascade the real schema carries. */
function store(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE file_registry (
      path TEXT PRIMARY KEY,
      hash TEXT NOT NULL
    );
    CREATE TABLE dependency_graph (
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      relation TEXT NOT NULL,
      PRIMARY KEY (source, target),
      FOREIGN KEY(source) REFERENCES file_registry(path) ON DELETE CASCADE
    );
  `);
  return db;
}

function register(db: Database.Database, ...paths: string[]): void {
  const insert = db.prepare('INSERT OR IGNORE INTO file_registry (path, hash) VALUES (?, ?)');
  for (const path of paths) insert.run(path, 'h');
}

function edgesIn(db: Database.Database): { source: string; target: string; relation: string }[] {
  return db
    .prepare('SELECT source, target, relation FROM dependency_graph ORDER BY source, target')
    .all() as { source: string; target: string; relation: string }[];
}

const candidate = (relativePath: string): BackfillCandidate => ({
  relativePath,
  absolutePath: `/abs/${relativePath}`,
});

/** Stands in for the chunker: maps a source string to whatever it declares. */
function extractorReturning(byPath: Record<string, GraphEdge[]>) {
  return (relativePath: string): readonly GraphEdge[] => byPath[relativePath] ?? [];
}

const readsNothing = () => '';

describe('backfillDependencyGraph', () => {
  it('re-extracts edges for every indexed file and records the generation', () => {
    const db = store();
    register(db, 'src/barrel.ts', 'src/thing.ts');

    const extracted = backfillDependencyGraph(
      db,
      [candidate('src/barrel.ts'), candidate('src/thing.ts')],
      extractorReturning({
        'src/barrel.ts': [
          { sourcePath: 'src/barrel.ts', targetPath: 'src/thing.ts', relation: 're-export' },
        ],
      }),
      readsNothing,
    );

    expect(extracted).toBe(2);
    expect(edgesIn(db)).toEqual([
      { source: 'src/barrel.ts', target: 'src/thing.ts', relation: 're-export' },
    ]);
  });

  it('runs once per generation, so an ordinary index run does not repeat it', () => {
    const db = store();
    register(db, 'src/a.ts');
    const files = [candidate('src/a.ts')];
    const extract = extractorReturning({});

    expect(backfillDependencyGraph(db, files, extract, readsNothing)).toBe(1);
    expect(backfillDependencyGraph(db, files, extract, readsNothing)).toBe(0);
  });

  it('re-extracts existing indexes marked by the pre-React resolver generation', () => {
    const db = store();
    register(db, 'src/a.ts');
    db.exec("CREATE TABLE rag_metadata_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.prepare('INSERT INTO rag_metadata_state (key, value) VALUES (?, ?)')
      .run('dependency-graph-extractor-v4', '1');

    expect(backfillDependencyGraph(db, [candidate('src/a.ts')], extractorReturning({}), readsNothing)).toBe(1);
  });

  // The reason it replaces rather than merges. `INSERT OR IGNORE` on a
  // `(source, target)` primary key keeps whichever relation landed first, so a
  // pair whose relation changed between generations would keep the stale one
  // and one row would describe two generations of the extractor.
  it('replaces a stale relation for a pair that now resolves differently', () => {
    const db = store();
    register(db, 'src/barrel.ts', 'src/thing.ts');
    db.prepare('INSERT INTO dependency_graph (source, target, relation) VALUES (?, ?, ?)').run(
      'src/barrel.ts',
      'src/thing.ts',
      'import',
    );

    backfillDependencyGraph(
      db,
      [candidate('src/barrel.ts')],
      extractorReturning({
        'src/barrel.ts': [
          { sourcePath: 'src/barrel.ts', targetPath: 'src/thing.ts', relation: 're-export' },
        ],
      }),
      readsNothing,
    );

    expect(edgesIn(db)).toEqual([
      { source: 'src/barrel.ts', target: 'src/thing.ts', relation: 're-export' },
    ]);
  });

  it('drops an edge the new extractor no longer produces', () => {
    const db = store();
    register(db, 'src/a.ts', 'src/gone.ts');
    db.prepare('INSERT INTO dependency_graph (source, target, relation) VALUES (?, ?, ?)').run(
      'src/a.ts',
      'src/gone.ts',
      'import',
    );

    backfillDependencyGraph(db, [candidate('src/a.ts')], extractorReturning({}), readsNothing);

    expect(edgesIn(db)).toEqual([]);
  });

  it('skips a discovered file the registry does not hold, which has no chunks to depend on', () => {
    const db = store();
    register(db, 'src/indexed.ts');

    const extracted = backfillDependencyGraph(
      db,
      [candidate('src/indexed.ts'), candidate('src/excluded.spec.ts')],
      extractorReturning({}),
      readsNothing,
    );

    expect(extracted).toBe(1);
  });

  // Same rule as `backfillNestGraph`: a file that vanished between discovery
  // and this pass is not worth failing an index run over.
  it('keeps going when a file cannot be read, and still finishes the rest', () => {
    const db = store();
    register(db, 'src/vanished.ts', 'src/present.ts');

    const extracted = backfillDependencyGraph(
      db,
      [candidate('src/vanished.ts'), candidate('src/present.ts')],
      extractorReturning({}),
      (absolutePath) => {
        if (absolutePath.includes('vanished')) throw new Error('ENOENT');
        return '';
      },
    );

    expect(extracted).toBe(1);
  });

  it('marks the generation even when nothing needed extracting', () => {
    const db = store();

    expect(backfillDependencyGraph(db, [], extractorReturning({}), readsNothing)).toBe(0);
    // The marker is set regardless, so an empty repository does not re-scan on
    // every single run for the rest of its life.
    const marker = db
      .prepare(`SELECT value FROM rag_metadata_state WHERE key LIKE 'dependency-graph-extractor-%'`)
      .get();
    expect(marker).toBeDefined();
  });
});
