import Database from 'better-sqlite3';
import { GraphEdge } from '../types';
import { ensureDependencyGraphSchema, replaceDependencyGraphForFile } from './dependency-graph-store';

/**
 * Marker for the extractor generation whose output is stored.
 *
 * Bumped when `NestChunker#extractDependencies` learns to see a construct it
 * previously walked past, because that is a change no per-file hash can detect:
 * the file content is identical and the edges it should produce are not.
 *
 * `v2` added re-exports. Before it, `export * from` produced no edge at all —
 * measured at 0 of 48 on this repository — so a barrel file had no outbound
 * dependencies and `query_dependency_graph` answered "what breaks if I change
 * this" without naming the published entry point that re-exports it.
 *
 * `v3` added relative `require()` and `import()` calls. They were skipped at
 * first as unmeasurable — this tree held one, in a spec — and stopped being
 * unmeasurable the moment `start-mcp-server.ts` began loading the indexer
 * lazily. The graph arm reported the three new gaps on the next run, which is
 * what a per-construct recall report is for.
 */
const EXTRACTOR_GENERATION_KEY = 'dependency-graph-extractor-v4';

/** One discovered source file, as `WorkspaceDiscoveryService` reports it. */
export interface BackfillCandidate {
  readonly relativePath: string;
  readonly absolutePath: string;
}

/**
 * Re-extracts dependency edges for every indexed file, once per extractor
 * generation.
 *
 * ## Why this exists rather than "just reindex"
 *
 * Edges are written when a file is indexed, and the indexer decides what to
 * index by content hash. Improving the extractor changes what a file *should*
 * produce without changing the file, so an ordinary run reports "up to date"
 * over a graph that is now known to be incomplete — and the operator has no
 * signal that anything is missing.
 *
 * A full reindex would fix it and would also re-embed every chunk, which costs
 * a provider run for a correction that needs no vectors at all. Edges come from
 * the AST. This reads the files, re-derives the edges, and leaves
 * `chunk_vectors` untouched.
 *
 * The one-shot marker follows `enrichExistingTSDoc`, which backfills derived
 * metadata the same way and for the same reason.
 *
 * @param db - Umbra's SQLite database.
 * @param files - Discovered source files, absolute and repository-relative.
 * @param extract - Produces the edges for one file's source text.
 * @param readFile - Reads a file, so callers can supply their own IO in tests.
 * @returns Number of files re-extracted; `0` when this generation already ran.
 */
export function backfillDependencyGraph(
  db: Database.Database,
  files: readonly BackfillCandidate[],
  extract: (relativePath: string, source: string) => readonly GraphEdge[],
  readFile: (absolutePath: string) => string,
): number {
  ensureDependencyGraphSchema(db);
  db.exec(
    `CREATE TABLE IF NOT EXISTS rag_metadata_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  );
  const alreadyRun = db
    .prepare(`SELECT 1 FROM rag_metadata_state WHERE key = ?`)
    .get(EXTRACTOR_GENERATION_KEY);
  if (alreadyRun !== undefined) return 0;

  // Only files the registry already holds. A file outside it has no chunks, so
  // it is not a `source` row the graph can carry — and `dependency_graph`
  // enforces that with a foreign key onto `file_registry(path)`.
  const indexed = new Map(
    (db.prepare(`SELECT path, hash FROM file_registry`).all() as { path: string; hash: string }[])
      .map((row) => [row.path, row.hash]),
  );

  let extracted = 0;
  for (const file of files) {
    const hash = indexed.get(file.relativePath);
    if (hash === undefined) continue;

    let source: string;
    try {
      source = readFile(file.absolutePath);
    } catch {
      // A file that vanished between discovery and this pass is not worth
      // failing a run over; the next run will not find it either. Same rule as
      // `backfillNestGraph`.
      continue;
    }

    const edges = extract(file.relativePath, source);
    db.transaction(() => {
      replaceDependencyGraphForFile(db, file.relativePath, edges, hash);
    })();
    extracted += 1;
  }

  db.prepare(`INSERT OR REPLACE INTO rag_metadata_state (key, value) VALUES (?, ?)`).run(
    EXTRACTOR_GENERATION_KEY,
    String(Date.now()),
  );

  return extracted;
}
