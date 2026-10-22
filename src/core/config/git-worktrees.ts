import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Which git worktree of the pinned repository a tool call is about.
 *
 * ## Why this exists
 *
 * Claude Code starts one MCP process per session and its subagents share it.
 * That process receives the session's start directory — the main checkout —
 * even when the agent asking works in `.claude/worktrees/<name>/`, and no
 * tools/call carries the caller's working directory. So the only way Umbra can
 * answer about the caller's own files is for the caller to say which worktree
 * it is in.
 *
 * ADR-024 constraint 3 forbids reading a *root* from a tool argument, because
 * an argument would hand ADR-011's path-traversal surface to the caller. This
 * module keeps that boundary and moves it from one directory to one
 * repository: the pinned root is still fixed at launch, and a call may select
 * only a worktree that `git worktree list` already reports for it. Any other
 * path is refused, however it is spelt.
 */

/** One entry of `git worktree list --porcelain`. */
export interface GitWorktree {
  /** Canonical absolute path of the working tree. */
  readonly path: string;
  /** Commit checked out, when git reported one. */
  readonly head?: string;
  /** Branch name without `refs/heads/`, or undefined when detached. */
  readonly branch?: string;
  /** True for the bare repository entry, which has no working tree. */
  readonly bare: boolean;
  /** True when git would prune the entry because its directory is gone. */
  readonly prunable: boolean;
}

/** A worktree a tool call may read, selected from the pinned repository's own list. */
export interface ResolvedWorktree {
  /** Canonical absolute root of the selected worktree. */
  readonly root: string;
  /** True when the selection is the pinned root itself. */
  readonly isPinnedRoot: boolean;
  /**
   * Main checkout of the repository the worktree belongs to: the pinned root,
   * or one of its submodules checked out inside it.
   */
  readonly repositoryRoot: string;
  /**
   * Where that repository sits inside the pinned root, as the index spells it:
   * `''` for the pinned repository itself, `'LONDONUW-AGENTS-DASHBOARD'` for a
   * submodule there. A file at `src/a.ts` in the worktree is indexed as
   * `<indexPrefix>/src/a.ts`.
   */
  readonly indexPrefix: string;
  /** Checked-out branch, when not detached. */
  readonly branch?: string;
  /** Checked-out commit. */
  readonly head?: string;
}

/** Stable reasons a requested worktree is refused. */
export type WorktreeResolutionCode =
  | 'WORKTREE_NOT_ABSOLUTE'
  | 'WORKTREE_NOT_FOUND'
  | 'WORKTREE_NOT_REGISTERED'
  | 'WORKTREE_GIT_UNAVAILABLE';

/** Thrown when a requested path is not one of the pinned repository's worktrees. */
export class WorktreeResolutionError extends Error {
  /**
   * @param code - Stable machine-readable reason.
   * @param message - Operator-facing explanation naming the recovery.
   */
  public constructor(public readonly code: WorktreeResolutionCode, message: string) {
    super(message);
    this.name = 'WorktreeResolutionError';
  }
}

/**
 * Runs one git command and returns its stdout.
 *
 * `execFile`, never a shell: no argument is ever interpreted, so a path with
 * spaces or metacharacters is data.
 */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<string>;

/** The default runner: the `git` on PATH, bounded so a hung git cannot hold a tool call. */
export const runGit: GitRunner = async (args, cwd) => {
  const { stdout } = await execFileAsync('git', [...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 15_000,
    windowsHide: true,
  });
  return stdout;
};

/**
 * Parses `git worktree list --porcelain -z`.
 *
 * With `-z` every attribute ends in NUL and a record ends in an extra NUL, so a
 * path containing a newline still parses as one path.
 *
 * @param output - Raw stdout of the command.
 * @returns One entry per record, in git's order (the main worktree first).
 */
export function parseWorktreeList(output: string): GitWorktree[] {
  const worktrees: GitWorktree[] = [];
  let current: { path?: string; head?: string; branch?: string; bare: boolean; prunable: boolean } | undefined;

  const flush = (): void => {
    if (current?.path !== undefined) {
      worktrees.push({
        path: current.path,
        head: current.head,
        branch: current.branch,
        bare: current.bare,
        prunable: current.prunable,
      });
    }
    current = undefined;
  };

  for (const field of output.split('\0')) {
    if (field === '') {
      flush();
      continue;
    }
    const space = field.indexOf(' ');
    const key = space === -1 ? field : field.slice(0, space);
    const value = space === -1 ? '' : field.slice(space + 1);
    if (key === 'worktree') {
      flush();
      current = { path: value, bare: false, prunable: false };
      continue;
    }
    if (current === undefined) continue;
    if (key === 'HEAD') current.head = value;
    else if (key === 'branch') current.branch = value.replace(/^refs\/heads\//, '');
    else if (key === 'bare') current.bare = true;
    else if (key === 'prunable') current.prunable = true;
  }
  flush();
  return worktrees;
}

/**
 * Lists the worktrees git records for a repository.
 *
 * @param repoRoot - Any working tree of the repository; normally the pinned root.
 * @param git - Injectable runner for tests.
 * @returns The repository's worktrees.
 * @throws {WorktreeResolutionError} When git cannot be run or the root is not a repository.
 */
export async function listGitWorktrees(repoRoot: string, git: GitRunner = runGit): Promise<GitWorktree[]> {
  let output: string;
  try {
    output = await git(['worktree', 'list', '--porcelain', '-z'], repoRoot);
  } catch (error: unknown) {
    throw new WorktreeResolutionError(
      'WORKTREE_GIT_UNAVAILABLE',
      `Cannot list the git worktrees of ${repoRoot}: ${error instanceof Error ? error.message : String(error)}. ` +
        'Worktree selection needs git and a git repository; omit `worktree` to query the pinned root.',
    );
  }
  return parseWorktreeList(output);
}

/**
 * Selects the worktree a requested path belongs to.
 *
 * The requested path may be the worktree root or any directory inside it — an
 * agent passes its current working directory, which is often a subdirectory.
 * Worktrees created by Claude Code live *inside* the main checkout
 * (`.claude/worktrees/<name>/`), so a path inside one is inside both; the
 * longest matching root wins, which is the worktree the path actually belongs to.
 *
 * Both sides are compared after `realpath`, so a symlink cannot make an
 * unregistered directory look like a registered one, and `..` segments cannot
 * survive into the comparison.
 *
 * The repository's initialised submodules are part of it, and so are their
 * worktrees. A superproject indexes its submodules' files (discovery walks
 * into them), and parallel work on a submodule happens in worktrees *of the
 * submodule* — in the superproject measured on 2026-10-22, 12 of its 17
 * `.worktrees/` entries had a gitdir under `.git/modules/<submodule>/`, which
 * the superproject's own `git worktree list` never shows.
 *
 * @param pinnedRoot - The repository root pinned at launch.
 * @param requested - Absolute path supplied by the caller.
 * @param git - Injectable runner for tests.
 * @returns The selected worktree.
 * @throws {WorktreeResolutionError} When the path is relative, missing, or not inside a registered worktree.
 */
export async function resolveWorktree(
  pinnedRoot: string,
  requested: string,
  git: GitRunner = runGit,
): Promise<ResolvedWorktree> {
  if (!path.isAbsolute(requested)) {
    throw new WorktreeResolutionError(
      'WORKTREE_NOT_ABSOLUTE',
      `The worktree must be an absolute path; received "${requested}". Pass your current working directory.`,
    );
  }
  const realRequested = realpathOrUndefined(requested);
  if (realRequested === undefined) {
    throw new WorktreeResolutionError('WORKTREE_NOT_FOUND', `The worktree path does not exist: ${requested}.`);
  }
  const realPinned = realpathOrUndefined(pinnedRoot) ?? path.resolve(pinnedRoot);

  const repositories: { root: string; prefix: string }[] = [{ root: realPinned, prefix: '' }];
  for (const submodule of await readInitialisedSubmodules(git, realPinned)) {
    repositories.push({ root: path.join(realPinned, submodule), prefix: submodule });
  }

  let best: { root: string; entry: GitWorktree; repository: { root: string; prefix: string } } | undefined;
  for (const repository of repositories) {
    // The pinned repository must be listable; a submodule that git cannot
    // describe simply offers no worktrees.
    let worktrees: GitWorktree[];
    try {
      worktrees = await listGitWorktrees(repository.root, git);
    } catch (error: unknown) {
      if (repository.prefix === '') throw error;
      continue;
    }
    if (repository.prefix !== '') {
      // For a submodule, git lists its main worktree as the gitdir under
      // `.git/modules/<name>`, not as the directory it is checked out in, so
      // the submodule's own checkout is added here.
      worktrees = [
        { path: repository.root, head: await readGitHead(git, repository.root), branch: await readGitBranch(git, repository.root), bare: false, prunable: false },
        ...worktrees,
      ];
    }
    for (const entry of worktrees) {
      if (entry.bare || entry.prunable) continue;
      const root = realpathOrUndefined(entry.path);
      if (root === undefined || !isSameOrInside(realRequested, root)) continue;
      if (best === undefined || root.length > best.root.length) best = { root, entry, repository };
    }
  }

  if (best === undefined) {
    throw new WorktreeResolutionError(
      'WORKTREE_NOT_REGISTERED',
      `${realRequested} is not inside any git worktree of ${realPinned}. ` +
        'Only worktrees listed by `git worktree list` for the served repository can be selected.',
    );
  }

  // A listed path is git's record, not proof of what is there now: a worktree
  // directory replaced by a symlink to another checkout would realpath into a
  // different repository that git has not marked prunable. The selection must
  // share the object store of the repository that listed it.
  if (best.root !== best.repository.root) {
    const [repositoryCommon, selectedCommon] = await Promise.all([
      gitCommonDir(best.repository.root, git),
      gitCommonDir(best.root, git),
    ]);
    if (repositoryCommon === undefined || selectedCommon !== repositoryCommon) {
      throw new WorktreeResolutionError(
        'WORKTREE_NOT_REGISTERED',
        `${best.root} is listed as a worktree of ${best.repository.root} but belongs to another repository on disk.`,
      );
    }
  }

  return {
    root: best.root,
    isPinnedRoot: best.root === realPinned,
    repositoryRoot: best.repository.root,
    indexPrefix: best.repository.prefix,
    branch: best.entry.branch,
    head: best.entry.head,
  };
}

/**
 * Reads the checked-out commit.
 *
 * @param git - Runner.
 * @param root - Working tree.
 * @returns The commit, or undefined for a repository with no commits yet.
 */
export async function readGitHead(git: GitRunner, root: string): Promise<string | undefined> {
  try {
    return (await git(['rev-parse', '--verify', '-q', 'HEAD'], root)).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The checked-out branch's short name, or undefined when detached. */
async function readGitBranch(git: GitRunner, root: string): Promise<string | undefined> {
  try {
    return (await git(['symbolic-ref', '--short', '-q', 'HEAD'], root)).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Paths with uncommitted changes, untracked files included and ignored ones not.
 *
 * `--no-optional-locks` matters: a plain `git status` refreshes the index and
 * takes `index.lock` to write it back, and run on every tool call it would race
 * the agent's own `git add` or `git commit` in that worktree. `--no-renames`
 * makes a rename a deletion plus an addition, so each path is its own
 * `XY PATH` field; a rename or copy entry, which carries its original path as
 * a second field, is still read correctly should a git version report one.
 *
 * @param git - Runner.
 * @param root - Working tree.
 * @returns Root-relative POSIX paths, possibly with duplicates.
 */
export async function readGitStatusPaths(git: GitRunner, root: string): Promise<string[]> {
  const output = await git(
    ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'],
    root,
  );
  const paths: string[] = [];
  const fields = output.split('\0');
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    if (field.length < 4) continue;
    const status = field.slice(0, 2);
    paths.push(field.slice(3));
    if (status.includes('R') || status.includes('C')) {
      const original = fields[index + 1];
      if (original !== undefined && original.length > 0) paths.push(original);
      index += 1;
    }
  }
  return paths;
}

/**
 * Paths git tracks at the working tree's index.
 *
 * @param git - Runner.
 * @param root - Working tree.
 * @returns Root-relative POSIX paths.
 */
export async function readGitTrackedPaths(git: GitRunner, root: string): Promise<string[]> {
  return (await git(['--no-optional-locks', 'ls-files', '-z'], root)).split('\0').filter((entry) => entry.length > 0);
}

/**
 * Submodule paths declared in `.gitmodules` and checked out in this working tree.
 *
 * @param git - Runner.
 * @param root - The superproject's working tree.
 * @returns Root-relative POSIX paths; empty without submodules.
 */
export async function readInitialisedSubmodules(git: GitRunner, root: string): Promise<string[]> {
  let output: string;
  try {
    output = await git(['config', '--file', '.gitmodules', '--null', '--get-regexp', '^submodule\\..*\\.path$'], root);
  } catch {
    // No `.gitmodules`, or no path entries: git exits 1 for "nothing matched".
    return [];
  }
  const submodules: string[] = [];
  for (const record of output.split('\0')) {
    const newline = record.indexOf('\n');
    if (newline === -1) continue;
    const submodule = record.slice(newline + 1).replace(/\/+$/, '');
    if (submodule.length === 0 || path.isAbsolute(submodule) || submodule.split('/').includes('..')) continue;
    // Initialised means it has its own `.git` (a file pointing into `.git/modules`).
    if (fs.existsSync(path.join(root, submodule, '.git'))) submodules.push(submodule);
  }
  return submodules;
}

/** The canonical shared git directory of a working tree, or undefined when git cannot say. */
async function gitCommonDir(root: string, git: GitRunner): Promise<string | undefined> {
  try {
    const output = (await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], root)).trim();
    return output.length === 0 ? undefined : realpathOrUndefined(output);
  } catch {
    return undefined;
  }
}

/** Canonicalises a path, or returns undefined when it does not exist. */
function realpathOrUndefined(candidate: string): string | undefined {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return undefined;
  }
}

/** Whether `candidate` is `root` or a descendant of it, by path segments rather than string prefix. */
function isSameOrInside(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
