import { readGitHead, readGitStatusPaths, runGit, type GitRunner } from '../config/git-worktrees';
import type { WorkspaceDiscovery } from '../config/workspace-discovery';
import type { IndexedGitState } from './index-stamp';

/**
 * Records which git state an index run read, for worktree overlays (ADR-038).
 *
 * The registry holds whatever content the run read from disk: the head's
 * version of a clean file, and the working-tree version of a dirty one. A
 * worktree overlay must know both, or it would serve the main checkout's
 * uncommitted edit as if it were in every worktree. Git failures are not
 * errors here: a project outside git simply records no state, and the overlay
 * then relies on its other proposals.
 */

/**
 * Captures the head and the uncommitted paths of a checkout.
 *
 * @param root - The checkout being indexed.
 * @param discovery - When given, keeps only the discovered source paths.
 * @param git - Injectable runner.
 * @returns The state, or undefined outside git or for a repository with no commits.
 */
export async function captureIndexedGitState(
  root: string,
  discovery?: Pick<WorkspaceDiscovery, 'sourceFiles'>,
  git: GitRunner = runGit,
): Promise<IndexedGitState | undefined> {
  const head = await readGitHead(git, root);
  if (head === undefined) return undefined;
  let dirty: string[];
  try {
    dirty = await readGitStatusPaths(git, root);
  } catch {
    return { head, dirty: [] };
  }
  // Only source the index could hold matters to an overlay. A checkout with
  // thousands of untracked non-source files must not grow a stamp that every
  // readiness check parses.
  if (discovery !== undefined) {
    const sources = new Set(discovery.sourceFiles.map((file) => file.relativePath));
    dirty = dirty.filter((relativePath) => sources.has(relativePath));
  }
  return { head, dirty: [...new Set(dirty)].sort() };
}

/**
 * Combines the state at a run's start with what changed while it ran.
 *
 * The head stays the one at the start, so commits made during the run are
 * still between it and any worktree. Paths dirty at the end are added, and so
 * is every file the run left pending: its registry row still holds an older
 * version than its disk, which is exactly what `dirty` exists to say.
 *
 * @param start - State captured before the run read any file.
 * @param end - State captured after the run, when available.
 * @param pending - Root-relative paths the run failed to commit.
 * @returns The state to stamp.
 */
export function mergeIndexedGitState(
  start: IndexedGitState | undefined,
  end: IndexedGitState | undefined,
  pending: readonly string[] = [],
): IndexedGitState | undefined {
  if (start === undefined) return undefined;
  return { head: start.head, dirty: [...new Set([...start.dirty, ...(end?.dirty ?? []), ...pending])].sort() };
}
