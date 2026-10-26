import Database from 'better-sqlite3';
import { loadVectorExtensionInto } from '../state/vector-extension';
import type { EmbeddingsIdentity, EmbeddingsPort } from './embeddings/embeddings.port';
import { commitGraphOnlyFile, commitIndexedFile, commitSkippedFile } from './indexed-file-rows';
import type { WorktreeOverlay } from './worktree-overlay';

/**
 * Reads the base index as a worktree would see it, by stacking the worktree's
 * rows inside a transaction that is always rolled back (ADR-038).
 *
 * ## Why a transaction, and why it is never committed
 *
 * Glean answers queries over an incremental database by hiding the base's
 * facts for the changed units and stacking new facts on top, so that "the
 * fact that the DB is a stack is invisible to a user making queries". SQLite
 * gives the same thing for free: inside a transaction on its own connection,
 * delete the base rows of every changed path, insert the worktree's rows, run
 * the read, roll back. Every existing query — FTS5 `bm25` with the real
 * corpus statistics, the unknown-term vocabulary (a term that lived only in a
 * hidden file is gone), cosine distance, the dependency and NestJS graphs —
 * then answers about the worktree without a line of it knowing. Other
 * connections keep their committed snapshot (WAL isolation), nothing is ever
 * written to disk, and a crash discards the transaction.
 *
 * ## The lock is held by a window with no I/O in it
 *
 * The transaction holds SQLite's write lock, and better-sqlite3 waits for a
 * lock synchronously, blocking its event loop. So the window must never wait
 * on anything: if it did, a writer in this process would freeze the loop the
 * window needs to finish, and writers in the other Umbra processes on the same
 * index would time out. The window therefore runs only synchronous SQL, plus
 * query embeddings answered from a memo. A query whose embedding is not in the
 * memo aborts the window, is embedded outside it, and the read is retried.
 * A `setImmediate` tripwire reports any window that outlived its macrotask.
 *
 * ## The FTS delete trigger is replaced inside the window
 *
 * `code_chunks_fts.chunk_id` is UNINDEXED, so the delete trigger scans the
 * whole FTS table once per deleted chunk: 11.5 s for 147 chunks on a
 * 47,775-chunk index (deidara, 2026-10-22). The window drops that trigger,
 * deletes the hidden chunks' FTS rows by rowid — looked up before the window
 * and re-validated inside it — and lets the foreign-key cascades remove the
 * rest: 4 ms for the same 147 chunks. The rollback restores the trigger.
 */

/** A read could not take the write lock in time; the caller should retry. */
export class OverlayBusyError extends Error {
  /** Always retryable: the lock is held by a peer for a bounded time. */
  public readonly retryable = true;

  /** @param message - What held the lock. */
  public constructor(message: string) {
    super(message);
    this.name = 'OverlayBusyError';
  }
}

/** A query embedding was requested inside the window; it is computed outside and the read retried. */
class OverlayEmbeddingMiss extends Error {
  /** @param text - The text whose embedding is missing. */
  public constructor(public readonly text: string) {
    super('A query embedding was requested inside the overlay window.');
    this.name = 'OverlayEmbeddingMiss';
  }
}

/** What a read receives: a connection carrying the worktree's rows. */
export interface OverlayView {
  /** Connection whose current transaction holds the overlay. */
  readonly db: Database.Database;
  /** Whether `vec_distance_cosine` is loaded on {@link db}. */
  readonly vectorSearchAvailable: boolean;
  /** Embeddings for the read; query embeddings come from the memo. */
  readonly embeddings: EmbeddingsPort;
}

/** What one scoped read cost, reported with its answer. */
export interface OverlayScopeStats {
  /** Attempts, including those aborted to embed a query outside the window. */
  readonly attempts: number;
  /** Time inside the last window, from BEGIN to ROLLBACK. */
  readonly windowMs: number;
  /** True when a window outlived its macrotask, which means it awaited real I/O. */
  readonly windowOutlivedMacrotask: boolean;
}

/** Options for {@link OverlayScope}. */
export interface OverlayScopeOptions {
  /** Path of the base index's SQLite file. */
  readonly dbPath: string;
  /** The process's embedding provider. */
  readonly embeddings: EmbeddingsPort;
  /** Longest wait for a peer's write lock before reporting busy; defaults to 1,000 ms. */
  readonly busyTimeoutMs?: number;
  /** True while this process is indexing: its own writes must never meet the window. */
  readonly isIndexing?: () => boolean;
}

/** The FTS rowids of a set of hidden paths, as last looked up. */
interface HiddenChunkRows {
  /** Every base chunk of the hidden paths, sorted. */
  readonly chunkIds: readonly string[];
  /** The FTS rows those chunks own. */
  readonly ftsRowids: readonly number[];
  /** The chunk id each of those FTS rows names, sorted: the fingerprint the window re-validates. */
  readonly ftsChunkIds: readonly string[];
}

/** Most query embeddings one process keeps. */
const MAX_QUERY_VECTORS = 256;

/** Retries for a read whose query embeddings were not yet in the memo (an initial and a clarified query). */
const MAX_ATTEMPTS = 3;

/**
 * Runs reads against a worktree's view of the base index.
 *
 * One instance per process and index: it owns a dedicated connection and
 * serializes the windows opened on it.
 */
export class OverlayScope {
  private connection?: { db: Database.Database; vectorSearchAvailable: boolean };

  private queue: Promise<void> = Promise.resolve();

  private readonly queryVectors = new Map<string, number[]>();

  private readonly hiddenRows = new Map<string, HiddenChunkRows>();

  /** @param options - The index file, the provider, and the busy policy. */
  public constructor(private readonly options: OverlayScopeOptions) {}

  /**
   * Runs one read with the overlay stacked on the base index.
   *
   * @param overlay - The worktree's rows. Built with `embed: false`, it carries graph rows only.
   * @param read - The read. It must not await anything but the view's embeddings.
   * @returns The read's result and what the window cost.
   * @throws {OverlayBusyError} When a peer holds the write lock past the busy timeout, or this process is indexing.
   */
  public async run<T>(
    overlay: WorktreeOverlay,
    read: (view: OverlayView) => Promise<T> | T,
  ): Promise<{ result: T; stats: OverlayScopeStats }> {
    let attempts = 0;
    for (;;) {
      attempts += 1;
      try {
        // The queue is held per window, not per read: the provider call below
        // runs outside it, so a slow embedding never delays another worktree's
        // read in this process — the graph tools need no provider at all.
        const { result, windowMs, outlived } = await this.exclusive(() => this.window(overlay, read));
        return { result, stats: { attempts, windowMs, windowOutlivedMacrotask: outlived } };
      } catch (error: unknown) {
        if (!(error instanceof OverlayEmbeddingMiss) || attempts >= MAX_ATTEMPTS) throw error;
        // Outside the window and the queue now: the rollback ran in `window`'s finally.
        this.rememberQuery(error.text, await this.options.embeddings.embedQuery(error.text));
      }
    }
  }

  /** Closes the dedicated connection. Exists for tests and shutdown. */
  public close(): void {
    this.connection?.db.close();
    this.connection = undefined;
  }

  /** One BEGIN … ROLLBACK window. */
  private async window<T>(
    overlay: WorktreeOverlay,
    read: (view: OverlayView) => Promise<T> | T,
  ): Promise<{ result: T; windowMs: number; outlived: boolean }> {
    if (this.options.isIndexing?.() === true) {
      throw new OverlayBusyError('This Umbra process is indexing; a worktree read would wait on its own writes.');
    }
    const { db, vectorSearchAvailable } = this.open();
    const hidden = hiddenPaths(overlay);
    const lookedUp = this.lookUpHiddenRows(db, hidden);
    const view: OverlayView = { db, vectorSearchAvailable, embeddings: this.memoEmbeddings() };

    let outlived = false;
    let open = false;
    const tripwire = setImmediate(() => {
      if (open) outlived = true;
    });
    try {
      try {
        db.exec('BEGIN IMMEDIATE');
      } catch (error: unknown) {
        if (isBusy(error)) {
          throw new OverlayBusyError('Another Umbra process is writing this index; retry the worktree read.');
        }
        throw error;
      }
      open = true;
      const startedAt = Date.now();
      try {
        this.stack(db, overlay, hidden, lookedUp);
        const result = await read(view);
        return { result, windowMs: Date.now() - startedAt, outlived };
      } finally {
        // SQLite rolls a transaction back by itself on some errors (a full
        // disk, an I/O error); a second ROLLBACK would then throw and replace
        // the real error with "no transaction is active".
        if (db.inTransaction) db.exec('ROLLBACK');
        open = false;
      }
    } finally {
      clearImmediate(tripwire);
    }
  }

  /** Hides the base rows of every changed or deleted path and writes the worktree's. */
  private stack(db: Database.Database, overlay: WorktreeOverlay, hidden: readonly string[], lookedUp: HiddenChunkRows): void {
    const rows = this.validHiddenRows(db, hidden, lookedUp);
    db.exec('DROP TRIGGER IF EXISTS code_chunks_fts_delete');
    if (rows.ftsRowids.length > 0) {
      db.prepare('DELETE FROM code_chunks_fts WHERE rowid IN (SELECT value FROM json_each(?))').run(JSON.stringify(rows.ftsRowids));
    }
    // The cascades from `file_registry` remove the chunks, their vectors, the
    // dependency edges and scans, and the NestJS rows of every hidden path.
    db.prepare('DELETE FROM file_registry WHERE path IN (SELECT value FROM json_each(?))').run(JSON.stringify(hidden));

    const identity: EmbeddingsIdentity = this.options.embeddings.identity;
    for (const file of overlay.files) {
      if (file.analyzed.chunks.length === 0) {
        commitSkippedFile(db, file.analyzed, file.analyzed.skeleton, 'empty-or-whitespace source in worktree');
      } else if (file.vectors === undefined) {
        commitGraphOnlyFile(db, file.analyzed);
      } else {
        commitIndexedFile(db, identity, file.analyzed, file.vectors);
      }
    }
  }

  /**
   * The FTS rowids of the hidden paths' base chunks, read before the window.
   *
   * The scan is the whole FTS table (89 ms at 47,775 chunks), so the answer is
   * cached per path set and re-validated inside the window, where the snapshot
   * can no longer move.
   */
  private lookUpHiddenRows(db: Database.Database, hidden: readonly string[]): HiddenChunkRows {
    const key = hidden.join('\0');
    const cached = this.hiddenRows.get(key);
    if (cached !== undefined) return cached;
    const rows = readHiddenRows(db, hidden);
    this.hiddenRows.set(key, rows);
    if (this.hiddenRows.size > 64) this.hiddenRows.delete(this.hiddenRows.keys().next().value!);
    return rows;
  }

  /** Confirms the looked-up rowids still name exactly the hidden chunks, or reads them again inside the window. */
  private validHiddenRows(db: Database.Database, hidden: readonly string[], lookedUp: HiddenChunkRows): HiddenChunkRows {
    const chunkIds = readChunkIds(db, hidden);
    const sameChunks = chunkIds.length === lookedUp.chunkIds.length && chunkIds.every((id, index) => id === lookedUp.chunkIds[index]);
    if (sameChunks) {
      const mapped = (db.prepare(
        'SELECT chunk_id FROM code_chunks_fts WHERE rowid IN (SELECT value FROM json_each(?))',
      ).all(JSON.stringify(lookedUp.ftsRowids)) as { chunk_id: string }[]).map((row) => row.chunk_id).sort();
      if (mapped.length === lookedUp.ftsChunkIds.length && mapped.every((id, index) => id === lookedUp.ftsChunkIds[index])) {
        return lookedUp;
      }
    }
    const fresh = readHiddenRows(db, hidden);
    this.hiddenRows.set(hidden.join('\0'), fresh);
    return fresh;
  }

  /** An embeddings port whose query embeddings come from the memo, and abort the window when absent. */
  private memoEmbeddings(): EmbeddingsPort {
    const delegate = this.options.embeddings;
    return {
      identity: delegate.identity,
      embedQuery: async (text: string) => {
        const vector = this.queryVectors.get(text);
        if (vector === undefined) throw new OverlayEmbeddingMiss(text);
        return vector;
      },
      embedDocuments: async () => {
        throw new Error('A worktree read must not embed documents inside the overlay window.');
      },
    };
  }

  /** Keeps the query memo bounded. */
  private rememberQuery(text: string, vector: number[]): void {
    this.queryVectors.delete(text);
    this.queryVectors.set(text, vector);
    while (this.queryVectors.size > MAX_QUERY_VECTORS) this.queryVectors.delete(this.queryVectors.keys().next().value!);
  }

  /** Opens the dedicated connection once: same file, its own vector extension, a short busy timeout. */
  private open(): { db: Database.Database; vectorSearchAvailable: boolean } {
    if (this.connection === undefined) {
      const db = new Database(this.options.dbPath, { fileMustExist: true, timeout: this.options.busyTimeoutMs ?? 1_000 });
      db.pragma('foreign_keys = ON');
      this.connection = { db, vectorSearchAvailable: loadVectorExtensionInto(db) };
    }
    return this.connection;
  }

  /** Serializes windows on the one connection. */
  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
}

/** Every path whose base rows the overlay replaces or hides, sorted. */
function hiddenPaths(overlay: WorktreeOverlay): string[] {
  return [...new Set([...overlay.files.map((file) => file.analyzed.relativePath), ...overlay.delta.deleted])].sort();
}

/** The base chunk ids of the hidden paths, through `idx_chunks_file`. */
function readChunkIds(db: Database.Database, hidden: readonly string[]): string[] {
  if (hidden.length === 0) return [];
  return (db.prepare('SELECT id FROM code_chunks WHERE file_path IN (SELECT value FROM json_each(?))').all(JSON.stringify(hidden)) as { id: string }[])
    .map((row) => row.id)
    .sort();
}

/** The hidden chunks and their FTS rowids: one scan of the FTS table. */
function readHiddenRows(db: Database.Database, hidden: readonly string[]): HiddenChunkRows {
  const chunkIds = readChunkIds(db, hidden);
  if (chunkIds.length === 0) return { chunkIds, ftsRowids: [], ftsChunkIds: [] };
  const rows = db.prepare(
    'SELECT rowid AS id, chunk_id FROM code_chunks_fts WHERE chunk_id IN (SELECT value FROM json_each(?))',
  ).all(JSON.stringify(chunkIds)) as { id: number; chunk_id: string }[];
  return {
    chunkIds,
    ftsRowids: rows.map((row) => row.id),
    ftsChunkIds: rows.map((row) => row.chunk_id).sort(),
  };
}

/** Whether an error is SQLite reporting a lock held by another connection. */
function isBusy(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  // Extended codes included: `SQLITE_BUSY_RECOVERY` is a peer replaying the WAL
  // after a crash, which is exactly as transient as a held lock.
  return typeof code === 'string' && (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED'));
}
