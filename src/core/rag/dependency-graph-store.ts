/**
 * @module DependencyGraphStore
 *
 * Owns the readiness marker for derived file-to-file relationships. An empty
 * edge set is valid for a file; an absent scan is not evidence that no edge
 * exists. Keeping those states separate is what lets GraphRAG skip an unknown
 * graph instead of confidently traversing a partial one.
 */

import type Database from 'better-sqlite3';
import type { GraphEdge } from '../types';

/** Readiness of one derived graph projection. */
export interface DependencyGraphReadiness {
  /** Whether every indexed source file has edges derived from its current hash. */
  readonly ready: boolean;
  /** Human-readable reason that is safe to return to an operator. */
  readonly reason: string;
  /** Indexed source files whose dependency projection is missing or stale. */
  readonly pendingFiles: number;
  /** Bounded sample of the exact files that need a fresh dependency scan. */
  readonly affectedPaths: string[];
}

/**
 * Creates the dependency projection's scan table and traversal indexes.
 *
 * @param db - Umbra's SQLite connection.
 * @returns Nothing.
 */
export function ensureDependencyGraphSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dependency_scan (
      file_path TEXT PRIMARY KEY,
      hash      TEXT NOT NULL,
      FOREIGN KEY (file_path) REFERENCES file_registry(path) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_graph_target ON dependency_graph(target);
    CREATE INDEX IF NOT EXISTS idx_graph_source_relation ON dependency_graph(source, relation);
  `);
}

/**
 * Replaces one file's dependencies and records the exact source hash scanned.
 *
 * @param db - Umbra's SQLite connection.
 * @param filePath - Indexed repository-relative source path.
 * @param edges - Dependencies extracted from that file's current source.
 * @param hash - Content hash from `file_registry`.
 * @returns Nothing.
 */
export function replaceDependencyGraphForFile(
  db: Database.Database,
  filePath: string,
  edges: readonly GraphEdge[],
  hash: string,
): void {
  const deleteEdges = db.prepare('DELETE FROM dependency_graph WHERE source = ?');
  const insertEdge = db.prepare(
    'INSERT OR IGNORE INTO dependency_graph (source, target, relation) VALUES (?, ?, ?)',
  );
  const recordScan = db.prepare(
    'INSERT OR REPLACE INTO dependency_scan (file_path, hash) VALUES (?, ?)',
  );

  deleteEdges.run(filePath);
  for (const edge of edges) {
    insertEdge.run(edge.sourcePath, edge.targetPath, edge.relation);
  }
  recordScan.run(filePath, hash);
}

/**
 * Determines whether dependency edges cover the current indexed corpus.
 *
 * @param db - Umbra's SQLite connection.
 * @returns Readiness that never confuses an empty graph with a complete graph.
 */
export function inspectDependencyGraphReadiness(
  db: Database.Database,
): DependencyGraphReadiness {
  const indexed = db.prepare(
    "SELECT COUNT(*) AS count FROM file_registry WHERE index_state = 'indexed'",
  ).get() as { count: number };
  if (indexed.count === 0) {
    return { ready: false, reason: 'No indexed source files are available.', pendingFiles: 0, affectedPaths: [] };
  }

  const pending = db.prepare(`
    SELECT r.path AS path
      FROM file_registry r
      LEFT JOIN dependency_scan s ON s.file_path = r.path
     WHERE r.index_state = 'indexed' AND (s.hash IS NULL OR s.hash <> r.hash)
     ORDER BY r.path
  `).all() as { path: string }[];
  if (pending.length > 0) {
    const affectedPaths = pending.slice(0, 20).map((row) => row.path);
    return {
      ready: false,
      reason: `${pending.length} indexed source file(s) lack a current dependency scan: ${affectedPaths.join(', ')}.`,
      pendingFiles: pending.length,
      affectedPaths,
    };
  }

  return { ready: true, reason: 'Dependency relationships cover the indexed source corpus.', pendingFiles: 0, affectedPaths: [] };
}
