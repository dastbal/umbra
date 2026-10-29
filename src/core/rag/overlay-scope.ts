import Database from 'better-sqlite3';
import type { EmbeddingsPort } from './embeddings/embeddings.port';
import { installOverlayView, openOverlayDatabase } from './overlay-database';
import type { WorktreeOverlay } from './worktree-overlay';

/** A transient SQLite lock prevented a read snapshot; the caller may retry. */
export class OverlayBusyError extends Error {
  /** A later read may succeed once the lock clears. */
  public readonly retryable = true;

  /** @param message - Reason the read could not proceed. */
  public constructor(message: string) {
    super(message);
    this.name = 'OverlayBusyError';
  }
}

/** A query vector requested during a read is computed outside that read and retried. */
class OverlayEmbeddingMiss extends Error {
  /** @param text - Query whose vector is missing from the memo. */
  public constructor(public readonly text: string) {
    super('A query embedding was requested inside the overlay window.');
    this.name = 'OverlayEmbeddingMiss';
  }
}

/** Connection carrying a consistent base snapshot and in-memory worktree rows. */
export interface OverlayView {
  /** Merged connection for the duration of one read. */
  readonly db: Database.Database;
  /** Whether `vec_distance_cosine` is available on the connection. */
  readonly vectorSearchAvailable: boolean;
  /** Query embeddings supplied by a bounded process memo. */
  readonly embeddings: EmbeddingsPort;
}

/** Cost and scheduling diagnostics for one scoped read. */
export interface OverlayScopeStats {
  /** Attempts including a retry after a missing query vector. */
  readonly attempts: number;
  /** Milliseconds spent inside the last read window. */
  readonly windowMs: number;
  /** Whether the read awaited work beyond its macrotask. */
  readonly windowOutlivedMacrotask: boolean;
}

/** Inputs needed to construct an isolated worktree view. */
export interface OverlayScopeOptions {
  /** Durable base SQLite index. */
  readonly dbPath: string;
  /** Embedding provider for missed query vectors. */
  readonly embeddings: EmbeddingsPort;
  /** Maximum SQLite wait for brief schema or snapshot locks. */
  readonly busyTimeoutMs?: number;
  /** Retained for callers that track index progress; readers never take its writer lock. */
  readonly isIndexing?: () => boolean;
}

const MAX_QUERY_VECTORS = 256;
const MAX_ATTEMPTS = 3;

/**
 * Reads a worktree through a disposable in-memory database. The durable index
 * is attached for WAL reads; worktree rows and hidden-path markers are written
 * only to `main` (memory). TEMP views merge both sources for graph and vector
 * queries. This never upgrades a transaction on the durable index to a writer.
 */
export class OverlayScope {
  private readonly queryVectors = new Map<string, number[]>();

  /** @param options - Durable index path, embeddings, and timeout. */
  public constructor(private readonly options: OverlayScopeOptions) {}

  /** Executes a read against the worktree view, embedding query misses outside it. */
  public async run<T>(
    overlay: WorktreeOverlay,
    read: (view: OverlayView) => Promise<T> | T,
  ): Promise<{ result: T; stats: OverlayScopeStats }> {
    let attempts = 0;
    for (;;) {
      attempts += 1;
      try {
        const { result, windowMs, outlived } = await this.window(overlay, read);
        return { result, stats: { attempts, windowMs, windowOutlivedMacrotask: outlived } };
      } catch (error: unknown) {
        if (!(error instanceof OverlayEmbeddingMiss) || attempts >= MAX_ATTEMPTS) throw error;
        this.rememberQuery(error.text, await this.options.embeddings.embedQuery(error.text));
      }
    }
  }

  /** No persistent connection remains after each read. */
  public close(): void {}

  /** Builds one isolated view, reads it, and discards all worktree rows. */
  private async window<T>(
    overlay: WorktreeOverlay,
    read: (view: OverlayView) => Promise<T> | T,
  ): Promise<{ result: T; windowMs: number; outlived: boolean }> {
    let db: Database.Database | undefined;
    let outlived = false;
    let open = false;
    const tripwire = setImmediate(() => { if (open) outlived = true; });
    const startedAt = Date.now();
    try {
      const connection = openOverlayDatabase(this.options.dbPath, this.options.busyTimeoutMs ?? 1_000);
      db = connection.db;
      db.exec('BEGIN');
      open = true;
      installOverlayView(db, overlay, this.options.embeddings.identity);
      const result = await read({
        db,
        vectorSearchAvailable: connection.vectorSearchAvailable,
        embeddings: this.memoEmbeddings(),
      });
      return { result, windowMs: Date.now() - startedAt, outlived };
    } catch (error: unknown) {
      if (isBusy(error)) throw new OverlayBusyError('The index read snapshot is briefly locked; retry the worktree read.');
      throw error;
    } finally {
      open = false;
      clearImmediate(tripwire);
      if (db !== undefined) {
        if (db.inTransaction) db.exec('ROLLBACK');
        db.close();
      }
    }
  }

  /** An embeddings port whose query vectors come from the memo. */
  private memoEmbeddings(): EmbeddingsPort {
    const delegate = this.options.embeddings;
    return {
      identity: delegate.identity,
      embedQuery: async (query: string) => {
        const vector = this.queryVectors.get(query);
        if (vector === undefined) throw new OverlayEmbeddingMiss(query);
        return vector;
      },
      embedDocuments: async () => {
        throw new Error('A worktree read must not embed documents inside its read window.');
      },
    };
  }

  /** Keeps repeated query vectors bounded in process memory. */
  private rememberQuery(query: string, vector: number[]): void {
    this.queryVectors.delete(query);
    this.queryVectors.set(query, vector);
    while (this.queryVectors.size > MAX_QUERY_VECTORS) this.queryVectors.delete(this.queryVectors.keys().next().value!);
  }
}

/** Identifies transient SQLite contention, including extended busy codes. */
function isBusy(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED'));
}
