import type { Database } from 'better-sqlite3';
import { writeLine } from '../observability/console-sink';

/**
 * Loads `sqlite-vec` into a SQLite connection, so vector distance can be
 * computed in SQL instead of in JavaScript.
 *
 * ## Why this matters more than it looks
 *
 * Ranking in JavaScript means every stored vector crosses the process
 * boundary. Extrapolated from this repository's own index to 50,000 chunks —
 * roughly a 5,000-file project — that is 146 MB marshalled per query even
 * after vectors became BLOBs (ADR-026). Computing the distance in SQL means
 * only the `k` rows that won ever become JavaScript objects.
 *
 * ## Why loading is allowed to fail
 *
 * `sqlite-vec` ships a native binary per platform as optional dependencies. On
 * a platform it does not publish, or a `better-sqlite3` build compiled without
 * extension support, `load` throws. That must degrade, not break: retrieval
 * falls back to `cosineSimilarity` over the same BLOBs, which is still 5.3×
 * fewer bytes and 14.7× faster than the JSON text it replaced.
 *
 * The failure is reported once, with its reason. A silent fallback would hide a
 * 100× performance difference behind identical-looking results — the shape of
 * failure ADR-017 was written about.
 *
 * @example
 * ```ts
 * const available = loadVectorExtension(db);
 * // available === false → rank in JS, and say so
 * ```
 */

/** Whether the extension loaded, and why not when it did not. */
export interface VectorExtensionStatus {
  /** True when `vec_distance_cosine` can be used in SQL. */
  readonly available: boolean;
  /** Present when unavailable: the reason, safe to print. */
  readonly reason?: string;
  /** Extension version, when available. */
  readonly version?: string;
}

let cached: VectorExtensionStatus | undefined;

/**
 * Loads the extension into `db`, once per process.
 *
 * The result is memoized because the answer cannot change within a process:
 * either the native binary is loadable or it is not. Repeating a failed load
 * per query would print the same reason on every search.
 *
 * @param db - An open SQLite connection.
 * @returns The status of the extension for this process.
 */
export function loadVectorExtension(db: Database): VectorExtensionStatus {
  if (cached !== undefined) return cached;

  try {
    // Required lazily so that importing this module never costs the native
    // binary's load time in a process that will not search.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sqliteVec = require('sqlite-vec') as { load: (connection: Database) => void };
    sqliteVec.load(db);

    const row = db.prepare('SELECT vec_version() AS version').get() as { version?: string };
    cached = { available: true, version: row?.version };
    return cached;
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    cached = { available: false, reason };

    writeLine(
      '⚙️  [DB] sqlite-vec is unavailable, so vector ranking runs in JavaScript ' +
        `instead of SQL: ${reason}`,
    );

    return cached;
  }
}

/**
 * Reports the status without attempting a load.
 *
 * @returns The memoized status, or `undefined` when no load has been attempted.
 */
export function vectorExtensionStatus(): VectorExtensionStatus | undefined {
  return cached;
}

/**
 * Forgets the memoized status.
 *
 * Exists for tests, which need to exercise both the loaded and unloaded paths
 * in one run. Not part of the runtime contract.
 */
export function resetVectorExtension(): void {
  cached = undefined;
}
