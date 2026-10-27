import Database from 'better-sqlite3';
import { agentPath } from '../config/agent-directory';
import { resolveWorktree, runGit, type GitRunner, type ResolvedWorktree } from '../config/git-worktrees';
import { runtimeRoot } from '../config/runtime-root';
import { AgentDB } from '../state/db';
import { loadVectorExtensionInto } from '../state/vector-extension';
import type { ToolWorktree } from '../tools/tool-result';
import type { EmbeddingsPort } from './embeddings/embeddings.port';
import { resolveEmbeddings } from './embeddings/embeddings-resolver';
import { readIndexStamp } from './index-stamp';
import { IndexerService } from './indexer';
import { OverlayScope, type OverlayScopeStats, type OverlayView } from './overlay-scope';
import { computeWorktreeDelta, type WorktreeDelta } from './worktree-delta';
import { WorktreeOverlayBuilder } from './worktree-overlay';

/**
 * Answers reads about one git worktree of the served repository (ADR-038).
 *
 * The three steps are each their own module, and this one only sequences them:
 * select the worktree from git's own list ({@link resolveWorktree}), ask git and
 * the content hash what differs ({@link computeWorktreeDelta}), and stack the
 * difference on the base index for the duration of one read
 * ({@link WorktreeOverlayBuilder}, {@link OverlayScope}).
 */

/** Collaborators of {@link WorktreeViewService}, all injectable for tests. */
export interface WorktreeViewDependencies {
  /** The root pinned at launch; the repository whose worktrees may be selected. */
  readonly pinnedRoot: string;
  /** The base index connection. */
  readonly baseDb: Database.Database;
  /** Path of the base index's SQLite file. */
  readonly dbPath: string;
  /** The process's embedding provider. */
  readonly embeddings: EmbeddingsPort;
  /** Git runner. */
  readonly git?: GitRunner;
  /** True while this process is indexing. */
  readonly isIndexing?: () => boolean;
}

/** A read's result, with the provenance every worktree answer carries. */
export interface WorktreeReadResult<T> {
  /** What the read returned. */
  readonly result: T;
  /** Which worktree, and what its overlay cost. */
  readonly worktree: ToolWorktree;
  /** What the write window cost: diagnostics, not part of the published result. */
  readonly window: OverlayScopeStats;
}

/** Sequences worktree selection, delta, overlay and scoped read. */
export class WorktreeViewService {
  private readonly builder: WorktreeOverlayBuilder;

  private readonly scope: OverlayScope;

  /** @param dependencies - Roots, connections and the provider. */
  public constructor(private readonly dependencies: WorktreeViewDependencies) {
    this.builder = new WorktreeOverlayBuilder(dependencies.embeddings, dependencies.baseDb);
    this.scope = new OverlayScope({
      dbPath: dependencies.dbPath,
      embeddings: dependencies.embeddings,
      isIndexing: dependencies.isIndexing,
    });
  }

  /**
   * Selects the worktree a caller-supplied path belongs to.
   *
   * @param requested - Absolute path; the caller's working directory is the expected value.
   * @returns The worktree.
   * @throws {WorktreeResolutionError} When the path is not inside one of the repository's worktrees.
   */
  public resolve(requested: string): Promise<ResolvedWorktree> {
    return resolveWorktree(this.dependencies.pinnedRoot, requested, this.dependencies.git ?? runGit);
  }

  /**
   * Computes what differs between a worktree and the base index, without building anything.
   *
   * @param worktree - A resolved worktree.
   * @returns The delta.
   */
  public delta(worktree: ResolvedWorktree): Promise<WorktreeDelta> {
    return computeWorktreeDelta({
      repositoryRoot: worktree.repositoryRoot,
      indexPrefix: worktree.indexPrefix,
      worktreeRoot: worktree.root,
      db: this.dependencies.baseDb,
      stamp: readIndexStamp(this.dependencies.pinnedRoot),
      git: this.dependencies.git ?? runGit,
    });
  }

  /**
   * Runs one index read as the worktree sees the index.
   *
   * @param worktree - A resolved worktree.
   * @param options - `embed: false` for reads that use no vectors (the graph tools).
   * @param read - The read; it must await nothing but the view's embeddings.
   * @returns The read's result and its provenance.
   * @throws {OverlayBusyError} When the index's write lock is held past the busy timeout.
   */
  public async read<T>(
    worktree: ResolvedWorktree,
    options: { readonly embed: boolean },
    read: (view: OverlayView) => Promise<T> | T,
  ): Promise<WorktreeReadResult<T>> {
    const startedAt = Date.now();
    const delta = await this.delta(worktree);
    if (worktree.isPinnedRoot || (delta.changed.length === 0 && delta.deleted.length === 0)) {
      const db = new Database(this.dependencies.dbPath, { readonly: true, fileMustExist: true });
      try {
        const vectorSearchAvailable = loadVectorExtensionInto(db);
        db.exec('BEGIN');
        const result = await read({ db, vectorSearchAvailable, embeddings: this.dependencies.embeddings });
        return {
          result,
          window: { attempts: 1, windowMs: Date.now() - startedAt, windowOutlivedMacrotask: false },
          worktree: provenanceOf(worktree, delta, { elapsedMs: Date.now() - startedAt }),
        };
      } finally {
        if (db.inTransaction) db.exec('ROLLBACK');
        db.close();
      }
    }
    const overlay = await this.builder.build(worktree, delta, options);
    const { result, stats } = await this.scope.run(overlay, read);
    return {
      result,
      window: stats,
      worktree: provenanceOf(worktree, delta, {
        chunksEmbedded: overlay.stats.embedded,
        chunksReused: overlay.stats.reused,
        elapsedMs: Date.now() - startedAt,
      }),
    };
  }

  /** Closes the overlay connection. */
  public close(): void {
    this.scope.close();
  }
}

/**
 * Provenance for a worktree answer that needed no overlay — a live filesystem
 * read, or a status report.
 *
 * @param worktree - The resolved worktree.
 * @param delta - Its delta, when computed.
 * @param cost - Embedding counts and wall time.
 * @returns The provenance record.
 */
export function provenanceOf(
  worktree: ResolvedWorktree,
  delta: WorktreeDelta | undefined,
  cost: { chunksEmbedded?: number; chunksReused?: number; elapsedMs: number },
): ToolWorktree {
  return {
    path: worktree.root,
    ...(worktree.branch === undefined ? {} : { branch: worktree.branch }),
    ...(worktree.head === undefined ? {} : { head: worktree.head }),
    isPinnedRoot: worktree.isPinnedRoot,
    ...(worktree.indexPrefix === '' ? {} : { indexPrefix: worktree.indexPrefix }),
    changedFiles: delta?.changed.length ?? 0,
    deletedFiles: delta?.deleted.length ?? 0,
    chunksEmbedded: cost.chunksEmbedded ?? 0,
    chunksReused: cost.chunksReused ?? 0,
    elapsedMs: cost.elapsedMs,
  };
}

let processView: WorktreeViewService | undefined;

/**
 * The process's worktree view over the pinned root's index, created on first use.
 *
 * @returns The shared service.
 */
export function worktreeViews(): WorktreeViewService {
  if (processView === undefined) {
    const pinnedRoot = runtimeRoot();
    // Opened first, outside any window: the singleton's schema initialisation
    // writes, and must never wait on the overlay's lock (ADR-038).
    const baseDb = AgentDB.getInstance();
    processView = new WorktreeViewService({
      pinnedRoot,
      baseDb,
      dbPath: agentPath(pinnedRoot, 'memory.db'),
      embeddings: resolveEmbeddings().port,
      isIndexing: () => IndexerService.running,
    });
  }
  return processView;
}

/** Forgets the process's view. Exists for tests. */
export function resetWorktreeViews(): void {
  processView?.close();
  processView = undefined;
}
