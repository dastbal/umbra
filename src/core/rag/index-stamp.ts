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
  /** Whether any batch failed. */
  readonly status: IndexStatus;
  /** Discovery failure recorded before any embedding call, when the scope is empty. */
  readonly diagnostic?: string;
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
  run: { filesIndexed: number; status: IndexStatus; diagnostic?: string },
): void {
  const stamp: IndexStamp = {
    provider: identity.provider,
    model: identity.model,
    dimensions: identity.dimensions,
    indexedAt: Date.now(),
    filesIndexed: run.filesIndexed,
    status: run.status,
    diagnostic: run.diagnostic,
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
      status: parsed.status === 'partial' || parsed.status === 'empty' ? parsed.status : 'complete',
      diagnostic: typeof parsed.diagnostic === 'string' ? parsed.diagnostic : undefined,
    };
  } catch {
    return undefined;
  }
}
