import * as fs from 'fs';
import { agentPath } from '../config/agent-directory';
import { EmbeddingsIdentity } from './embeddings/embeddings.port';

/**
 * Records which embedding provider built the code index, and whether it is
 * complete.
 *
 * ## Why a separate file from `index.meta.json`
 *
 * `index.meta.json` already exists and is owned by
 * `DeepAgentFactory.ensureIndexFresh`, which writes `{ indexedAt }` after a
 * successful sync and reads it back as a five-minute TTL. Writing identity into
 * the same file would be silently destroyed by that write, and changing what
 * the factory writes would alter the freshness behaviour of every existing
 * command. So the stamp gets its own file and the TTL file is left exactly as
 * it is.
 *
 * ## Why the stamp exists at all
 *
 * ADR-017's third failure was an index reporting `✅ Indexing Complete` over
 * missing content. Under `umbra mcp` the consumer of that claim is another
 * agent, which has no terminal to check. `status` is therefore recorded, not
 * inferred, and travels with every retrieval answer.
 *
 * @example
 * ```ts
 * writeIndexStamp(root, { provider: 'ollama', model: 'nomic-embed-text', ... }, {
 *   filesIndexed: 91,
 *   status: 'complete',
 * });
 * ```
 */

/** Whether the index covers everything it attempted. */
export type IndexStatus = 'complete' | 'partial' | 'empty';

/** What is known about the index on disk. */
export interface IndexStamp {
  /** Provider that wrote the vectors. */
  readonly provider: EmbeddingsIdentity['provider'];
  /** Model that wrote them. */
  readonly model: string;
  /** Vector length, for diagnosing a model that changed dimensions. */
  readonly dimensions: number;
  /** When the run finished, as epoch milliseconds. */
  readonly indexedAt: number;
  /** How many files were embedded in this run. */
  readonly filesIndexed: number;
  /** Source files discovered when the stamp was written, when known. */
  readonly discoveredFiles?: number;
  /** Source files durably indexed or intentionally skipped, when known. */
  readonly coveredFiles?: number;
  /** Whether any batch failed. */
  readonly status: IndexStatus;
  /** Discovery failure recorded before any embedding call, when the scope is empty. */
  readonly diagnostic?: string;
  /**
   * The git state the run indexed: the head when it started and every path that
   * had uncommitted changes. A worktree overlay (ADR-038) reads it to know which
   * paths the index may hold in a version no commit has. Absent for a run
   * outside git, or for a stamp written before 2.4.0.
   */
  readonly git?: IndexedGitState;
}

/** Git state recorded by an index run. */
export interface IndexedGitState {
  /** Commit checked out when the run started. */
  readonly head: string;
  /**
   * Root-relative source paths with uncommitted changes at the run's start or
   * end, plus every file the run left pending, whose registry row still holds
   * an older version than its disk. A run that fails before re-indexing any
   * file keeps the previous stamp's state, which still describes the registry.
   */
  readonly dirty: readonly string[];
}

/** File name of the stamp inside the workspace directory. */
export const INDEX_STAMP_FILE = 'index.identity.json';

/**
 * Persists the stamp for the most recent indexing run.
 *
 * Never throws: failing to record provenance must not fail an index that
 * otherwise succeeded. A missing stamp is handled by {@link readIndexStamp},
 * which reports the absence rather than inventing a value.
 *
 * @param rootDir - Project root whose workspace receives the stamp.
 * @param identity - The embedding identity that wrote the vectors.
 * @param run - Counts and status for this run.
 * @returns Nothing.
 */
export function writeIndexStamp(
  rootDir: string,
  identity: EmbeddingsIdentity,
  run: {
    filesIndexed: number;
    status: IndexStatus;
    diagnostic?: string;
    discoveredFiles?: number;
    coveredFiles?: number;
    git?: IndexedGitState;
  },
): void {
  const stamp: IndexStamp = {
    provider: identity.provider,
    model: identity.model,
    dimensions: identity.dimensions,
    indexedAt: Date.now(),
    filesIndexed: run.filesIndexed,
    discoveredFiles: run.discoveredFiles,
    coveredFiles: run.coveredFiles,
    status: run.status,
    diagnostic: run.diagnostic,
    git: run.git,
  };

  try {
    fs.writeFileSync(
      agentPath(rootDir, INDEX_STAMP_FILE),
      JSON.stringify(stamp, null, 2),
      'utf-8',
    );
  } catch {
    // Provenance is valuable, but not more valuable than the index itself.
  }
}

/**
 * Reads the stamp, if one was written.
 *
 * @param rootDir - Project root to read from.
 * @returns The stamp, or `undefined` when absent or unreadable.
 */
export function readIndexStamp(rootDir: string): IndexStamp | undefined {
  try {
    const raw = fs.readFileSync(agentPath(rootDir, INDEX_STAMP_FILE), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<IndexStamp>;

    if (
      (parsed.provider !== 'vertex' && parsed.provider !== 'ollama') ||
      typeof parsed.model !== 'string' ||
      typeof parsed.indexedAt !== 'number'
    ) {
      // A malformed stamp is treated as no stamp. Returning a half-populated
      // one would let a caller print a provider that nobody recorded.
      return undefined;
    }

    return {
      provider: parsed.provider,
      model: parsed.model,
      dimensions: typeof parsed.dimensions === 'number' ? parsed.dimensions : 0,
      indexedAt: parsed.indexedAt,
      filesIndexed: typeof parsed.filesIndexed === 'number' ? parsed.filesIndexed : 0,
      discoveredFiles: typeof parsed.discoveredFiles === 'number' ? parsed.discoveredFiles : undefined,
      coveredFiles: typeof parsed.coveredFiles === 'number' ? parsed.coveredFiles : undefined,
      status: parsed.status === 'partial' || parsed.status === 'empty' ? parsed.status : 'complete',
      diagnostic: typeof parsed.diagnostic === 'string' ? parsed.diagnostic : undefined,
      git: parseIndexedGitState(parsed.git),
    };
  } catch {
    return undefined;
  }
}

/** Accepts the recorded git state only when its shape is exactly what a run writes. */
function parseIndexedGitState(value: unknown): IndexedGitState | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as { head?: unknown; dirty?: unknown };
  if (typeof candidate.head !== 'string' || candidate.head.length === 0) return undefined;
  if (!Array.isArray(candidate.dirty) || candidate.dirty.some((entry) => typeof entry !== 'string')) return undefined;
  return { head: candidate.head, dirty: candidate.dirty as string[] };
}
