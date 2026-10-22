import { z } from 'zod';
import type { ResolvedWorktree } from '../../core/config/git-worktrees';
import type * as WorktreeViewModule from '../../core/rag/worktree-view';

/**
 * The optional `worktree` argument shared by the tools that can answer about
 * one git worktree of the served repository (ADR-038).
 *
 * Claude Code gives an MCP server the session's start directory — the main
 * checkout, even for a desktop worktree session — and no tools/call says
 * where its caller works. So the caller says it. The argument selects; it does
 * not authorise: only a worktree that `git worktree list` reports for the
 * served repository is accepted, which keeps ADR-024 constraint 3's boundary
 * at the repository instead of dropping it.
 */

/** Input schema for the `worktree` argument. */
export const worktreeArgument = z
  .string()
  .min(1)
  .max(4096)
  .optional()
  .describe(
    'Absolute path of the git worktree you are working in — pass your current working directory. ' +
      'The answer then describes that worktree, uncommitted edits and new files included. ' +
      'Only worktrees of the served repository are accepted. Omit to read the served checkout as indexed.',
  );

/** A successful selection, with the service that will answer about it. */
export interface WorktreeSelection {
  readonly ok: true;
  readonly worktree: ResolvedWorktree;
  readonly views: WorktreeViewModule.WorktreeViewService;
  readonly provenanceOf: typeof WorktreeViewModule.provenanceOf;
}

/** A refused selection, with the message that names the recovery. */
export interface WorktreeRefusal {
  readonly ok: false;
  readonly message: string;
}

let viewModule: typeof WorktreeViewModule | undefined;

/**
 * Loads the worktree view on first use.
 *
 * Required lazily, like the indexing modules in `start-mcp-server.ts`: it pulls
 * in the indexer and the TypeScript chunker, and an eager import of the indexer
 * once cost 2.9 s before the MCP handshake (ADR-024 amendment 15). A session
 * that never selects a worktree never pays for it.
 */
function loadWorktreeViews(): typeof WorktreeViewModule {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  viewModule ??= require('../../core/rag/worktree-view') as typeof WorktreeViewModule;
  return viewModule;
}

/**
 * Selects the worktree a caller named.
 *
 * @param requested - The caller's `worktree` argument.
 * @returns The selection, or a refusal whose message says why.
 */
export async function selectWorktree(requested: string): Promise<WorktreeSelection | WorktreeRefusal> {
  const module = loadWorktreeViews();
  const views = module.worktreeViews();
  try {
    return { ok: true, worktree: await views.resolve(requested), views, provenanceOf: module.provenanceOf };
  } catch (error: unknown) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
