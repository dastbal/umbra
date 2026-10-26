import type Database from 'better-sqlite3';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  readGitHead,
  readGitStatusPaths,
  readGitTrackedPaths,
  readInitialisedSubmodules,
  runGit,
  type GitRunner,
} from '../config/git-worktrees';
import {
  WorkspaceDiscoveryService,
  type WorkspaceArtifactKind,
  type WorkspaceDiscovery,
  type WorkspaceFile,
} from '../config/workspace-discovery';
import type { IndexStamp } from './index-stamp';

/**
 * Which files of a worktree differ from what the base index holds.
 *
 * ## The rule
 *
 * Git proposes, the content hash decides. Git is asked for every path that
 * *could* differ, and each candidate is then compared with
 * `file_registry.hash`, the index's own definition of "changed". A wrong
 * candidate costs one md5 and never reaches the overlay; only a path no
 * proposal names can be missed. The proposals are:
 *
 * - the worktree's uncommitted changes and untracked files;
 * - the main checkout's, because the index was built from its disk;
 * - the commits between the main checkout's head and the worktree's;
 * - the commits between the head the index was built at and the worktree's,
 *   with the paths that run saw uncommitted or left pending (the stamp's `git`);
 * - every indexed path git does not track: discovery never reads `.gitignore`,
 *   so the index can hold generated or scratch source that no status reports.
 *
 * The last set is proposed for *change* only, never for deletion, and only
 * for a checkout other than the repository's own. A file git
 * ignores is an artifact of a checkout's environment — a generated client, a
 * nested repository, a scratch copy — not part of the branch, so a worktree
 * that has not produced it has not deleted it; the base's version stays
 * visible until the worktree holds a version of its own. Measured on
 * 2026-10-22, one superproject's index held 8,417 such paths, 7,109 of them
 * under an untracked `.worktrees/` directory; treating them as deletions hid
 * them from every worktree and cost 120–200 ms per call.
 *
 * Hashing every file instead would be exact without git, and is what the full
 * index inspection does: 401 ms on this repository (ADR-024 amendment 16), and
 * proportionally more on an 8,417-file one. `git status` on that repository took
 * 30 to 80 ms (measured 2026-10-22).
 */

/** A worktree file whose content the base index does not hold. */
export interface DeltaFile extends WorkspaceFile {
  /** The same file's path relative to the worktree root, which differs from `relativePath` under a submodule. */
  readonly worktreePath: string;
}

/** The worktree's departures from the base index. */
export interface WorktreeDelta {
  /** Canonical worktree root. */
  readonly worktreeRoot: string;
  /** Where the worktree's repository sits in the index: `''`, or a submodule path. */
  readonly indexPrefix: string;
  /** Files present in the worktree whose content the base index does not hold, by index path. */
  readonly changed: readonly DeltaFile[];
  /** Index paths the base index holds and the worktree does not. */
  readonly deleted: readonly string[];
  /** Content hash of every changed file, by index path. */
  readonly hashes: ReadonlyMap<string, string>;
  /** Stable identity of this delta: equal signatures mean an identical overlay. */
  readonly signature: string;
  /** How many paths git proposed before the hash check. */
  readonly candidates: number;
}

/** Inputs to {@link computeWorktreeDelta}. */
export interface WorktreeDeltaInput {
  /**
   * Main checkout of the worktree's repository: the pinned root, or a
   * submodule checked out inside it. The index was built from its disk.
   */
  readonly repositoryRoot: string;
  /** Where that repository sits in the index; `''` (the default) for the pinned repository. */
  readonly indexPrefix?: string;
  /** Canonical root of the selected worktree. */
  readonly worktreeRoot: string;
  /** Connection used only to read `file_registry`. */
  readonly db: Database.Database;
  /** The base index stamp, whose `git` field names the indexed head when recorded. */
  readonly stamp?: IndexStamp;
  /** Injectable git runner. */
  readonly git?: GitRunner;
  /** Injectable discovery, used only when a candidate is new to the index. */
  readonly discover?: (root: string) => WorkspaceDiscovery;
}

/** Discovery is half a second on a large repository, so it is reused until the set of new paths changes. */
const discoveryCache = new Map<string, { key: string; files: ReadonlyMap<string, WorkspaceArtifactKind> }>();

/** Tree differences between two commits are immutable, so each pair is asked once. */
const treeDiffCache = new Map<string, string[]>();

/** Indexed paths git does not track, with their registry hashes, per repository, index version and head. */
const untrackedIndexedCache = new Map<string, { key: string; hashes: ReadonlyMap<string, string> }>();

/**
 * Computes the worktree's delta against the base index.
 *
 * Git speaks in the worktree's own paths; the index in the pinned root's. For
 * the pinned repository they are the same. For a submodule's worktree every
 * path is translated by {@link WorktreeDeltaInput.indexPrefix}, and the
 * stamp's git state — recorded for the pinned repository only — is not used.
 *
 * @param input - Roots, the registry connection, and injectable collaborators.
 * @returns The changed and deleted paths, with a signature for caching.
 * @throws {Error} When git cannot describe the worktree; the caller reports it.
 */
export async function computeWorktreeDelta(input: WorktreeDeltaInput): Promise<WorktreeDelta> {
  const git = input.git ?? runGit;
  const prefix = input.indexPrefix ?? '';
  const toIndex = (relativePath: string): string => (prefix === '' ? relativePath : `${prefix}/${relativePath}`);
  const stamp = prefix === '' ? input.stamp : undefined;
  const worktreeRoot = input.worktreeRoot;
  const realWorktree = fs.realpathSync(worktreeRoot);
  const sameCheckout = path.resolve(input.repositoryRoot) === path.resolve(worktreeRoot);

  const [worktreeHead, repositoryHead] = await Promise.all([
    readGitHead(git, worktreeRoot),
    sameCheckout ? Promise.resolve<string | undefined>(undefined) : readGitHead(git, input.repositoryRoot),
  ]);
  const indexedHead = stamp?.git?.head;

  const [worktreeStatus, repositoryStatus, repositoryDiff, indexedDiff, untrackedIndexed] = await Promise.all([
    readGitStatusPaths(git, worktreeRoot),
    sameCheckout ? Promise.resolve<string[]>([]) : readGitStatusPaths(git, input.repositoryRoot),
    treeDiff(git, worktreeRoot, repositoryHead, worktreeHead),
    treeDiff(git, worktreeRoot, indexedHead, worktreeHead),
    // In the repository's own checkout the ignored artifacts are the very files
    // the index was read from; only another checkout can hold other versions.
    // Hashing them here would re-check 8,417 files per call (550 ms, measured
    // 2026-10-22) to find edits the no-argument path does not see either.
    sameCheckout
      ? Promise.resolve<ReadonlyMap<string, string>>(new Map())
      : untrackedIndexedPaths(git, input.repositoryRoot, prefix, input.db, input.stamp, repositoryHead ?? worktreeHead),
  ]);
  // Paths git itself says differ: these may be deleted as well as changed.
  const deletable = new Set<string>([
    ...worktreeStatus, ...repositoryStatus, ...repositoryDiff, ...indexedDiff, ...(stamp?.git?.dirty ?? []),
    ...(sameCheckout ? [] : await initialisedSubmoduleProposals(git, realWorktree, input.repositoryRoot)),
  ]);
  const candidates = new Set<string>([...deletable, ...untrackedIndexed.keys()]);

  const registry = readRegistryHashes(input.db, [...deletable], toIndex);
  const changed: DeltaFile[] = [];
  const deleted: string[] = [];
  const hashes = new Map<string, string>();
  const unindexed: { worktreePath: string; absolutePath: string }[] = [];
  // Ignored artifacts usually live under a directory the worktree does not
  // have at all (a nested repository, `.worktrees/<name>/`): checking each
  // ancestor directory once skips every file under a missing one, instead of
  // one lstat per file (50 ms for 8,417 paths).
  const directoryPresent = new Map<string, boolean>();

  for (const worktreePath of [...candidates].sort()) {
    const indexedHash = registry.get(worktreePath) ?? untrackedIndexed.get(worktreePath);
    if (!deletable.has(worktreePath) && !ancestorsExist(realWorktree, worktreePath, directoryPresent)) continue;
    const absolutePath = containedRegularFile(realWorktree, worktreePath);
    if (absolutePath === undefined) {
      // Absent, a symlink, or reached through one: the worktree has no source
      // here that Umbra may read, so an indexed version git reports as
      // changed must be hidden. An ignored artifact the worktree lacks is not.
      if (indexedHash !== undefined && deletable.has(worktreePath)) deleted.push(toIndex(worktreePath));
      continue;
    }
    if (indexedHash === undefined) {
      unindexed.push({ worktreePath, absolutePath });
      continue;
    }
    const hash = md5File(absolutePath);
    if (hash === undefined) continue;
    if (hash !== indexedHash) {
      changed.push({ absolutePath, relativePath: toIndex(worktreePath), worktreePath, kind: artifactKindOf(worktreePath) });
      hashes.set(toIndex(worktreePath), hash);
    }
  }

  // A path the index has never held is in scope only if discovery would index
  // it — a new `.ts` outside every tsconfig, or a spec, is not source here
  // either. Discovery runs only when such a path exists.
  if (unindexed.length > 0) {
    const scope = discoveredScope(worktreeRoot, worktreeHead, unindexed.map((entry) => entry.worktreePath), input.discover);
    for (const { worktreePath, absolutePath } of unindexed) {
      const kind = scope.get(worktreePath);
      if (kind === undefined) continue;
      const hash = md5File(absolutePath);
      if (hash === undefined) continue;
      changed.push({ absolutePath, relativePath: toIndex(worktreePath), worktreePath, kind });
      hashes.set(toIndex(worktreePath), hash);
    }
  }

  changed.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  deleted.sort();
  const signature = crypto
    .createHash('sha256')
    .update(realWorktree)
    .update('\0')
    .update(prefix)
    .update('\0')
    .update(changed.map((file) => `${file.relativePath}:${hashes.get(file.relativePath)}`).join('\0'))
    .update('\0')
    .update(deleted.join('\0'))
    .digest('hex');

  return { worktreeRoot: realWorktree, indexPrefix: prefix, changed, deleted, hashes, signature, candidates: candidates.size };
}

/** Clears every cache this module keeps. Exists for tests. */
export function resetWorktreeDeltaCache(): void {
  discoveryCache.clear();
  treeDiffCache.clear();
  untrackedIndexedCache.clear();
}

/**
 * Changes inside the submodules a superproject worktree has initialised.
 *
 * The superproject's own status reports a submodule as one modified gitlink,
 * never the files in it, and its `ls-files` lists none of them, so without
 * this a file deleted inside a worktree's submodule would be handled as an
 * ignored artifact and stay visible. Each submodule the worktree checked out
 * is asked directly, against the same submodule in the main checkout.
 */
async function initialisedSubmoduleProposals(git: GitRunner, worktreeRoot: string, repositoryRoot: string): Promise<string[]> {
  const submodules = await readInitialisedSubmodules(git, worktreeRoot);
  const proposals = await Promise.all(submodules.map(async (submodule) => {
    const inWorktree = path.join(worktreeRoot, submodule);
    const [status, worktreeHead, mainHead] = await Promise.all([
      readGitStatusPaths(git, inWorktree).catch(() => [] as string[]),
      readGitHead(git, inWorktree),
      readGitHead(git, path.join(repositoryRoot, submodule)),
    ]);
    const committed = await treeDiff(git, inWorktree, mainHead, worktreeHead);
    return [...status, ...committed].map((relativePath) => `${submodule}/${relativePath}`);
  }));
  return proposals.flat();
}

/** Paths that differ between two commits; empty when either is unknown or they are equal. */
async function treeDiff(git: GitRunner, root: string, from: string | undefined, to: string | undefined): Promise<string[]> {
  if (from === undefined || to === undefined || from === to) return [];
  const key = `${from}..${to}`;
  const cached = treeDiffCache.get(key);
  if (cached !== undefined) return cached;
  let paths: string[];
  try {
    paths = (await git(['diff', '--name-only', '--no-renames', '-z', from, to], root))
      .split('\0')
      .filter((entry) => entry.length > 0);
  } catch {
    // A recorded head that this repository no longer has (rewritten history),
    // or a git that timed out under load: the other proposals still stand, and
    // the hash check stays exact for them. Not cached, so a transient failure
    // is asked again next call rather than remembered as "nothing changed".
    return [];
  }
  treeDiffCache.set(key, paths);
  return paths;
}

/**
 * Indexed paths under the repository that git does not track there, with
 * their hashes, keyed by their path in the repository.
 *
 * Read once per repository, base index version and head: the registry and
 * `ls-files` are tens of milliseconds on a large repository, and there is no
 * reason to pay them per call.
 */
async function untrackedIndexedPaths(
  git: GitRunner,
  repositoryRoot: string,
  prefix: string,
  db: Database.Database,
  stamp: IndexStamp | undefined,
  head: string | undefined,
): Promise<ReadonlyMap<string, string>> {
  const version = db.prepare('SELECT COUNT(*) AS files, MAX(last_indexed) AS latest FROM file_registry').get() as {
    files: number;
    latest: number | null;
  };
  const key = `${stamp?.indexedAt ?? ''}:${version.files}:${version.latest ?? ''}:${head ?? ''}`;
  const cached = untrackedIndexedCache.get(repositoryRoot);
  if (cached?.key === key) return cached.hashes;
  let tracked: Set<string>;
  try {
    tracked = new Set(await readGitTrackedPaths(git, repositoryRoot));
  } catch {
    return new Map();
  }
  const within = prefix === '' ? '' : `${prefix}/`;
  const hashes = new Map<string, string>();
  for (const row of db.prepare('SELECT path, hash FROM file_registry').all() as { path: string; hash: string }[]) {
    if (!row.path.startsWith(within)) continue;
    const repositoryPath = row.path.slice(within.length);
    if (!tracked.has(repositoryPath)) hashes.set(repositoryPath, row.hash);
  }
  untrackedIndexedCache.set(repositoryRoot, { key, hashes });
  return hashes;
}

/** Size and modification time, as a cache-key fragment; empty when the path cannot be read. */
function statStamp(absolutePath: string): string {
  try {
    const stat = fs.lstatSync(absolutePath);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return '';
  }
}

/** Whether every ancestor directory of the path exists in the worktree, memoized for one delta. */
function ancestorsExist(root: string, relativePath: string, memo: Map<string, boolean>): boolean {
  for (let slash = relativePath.indexOf('/'); slash !== -1; slash = relativePath.indexOf('/', slash + 1)) {
    const directory = relativePath.slice(0, slash);
    let present = memo.get(directory);
    if (present === undefined) {
      present = fs.existsSync(path.join(root, directory));
      memo.set(directory, present);
    }
    if (!present) return false;
  }
  return true;
}

/** Reads registry hashes for the candidate paths only, keyed by the worktree path. */
function readRegistryHashes(
  db: Database.Database,
  paths: readonly string[],
  toIndex: (worktreePath: string) => string,
): Map<string, string> {
  const hashes = new Map<string, string>();
  const select = db.prepare('SELECT hash FROM file_registry WHERE path = ?');
  for (const worktreePath of paths) {
    const row = select.get(toIndex(worktreePath)) as { hash: string } | undefined;
    if (row !== undefined) hashes.set(worktreePath, row.hash);
  }
  return hashes;
}

/**
 * The absolute path of a git-reported path, only when it is a regular file
 * that really lies inside the worktree.
 *
 * Discovery skips symlinks (it walks with `Dirent.isFile()`), so the overlay
 * does too: a link inside a worktree — or a parent directory replaced by one —
 * must not become a way to read a file outside it (ADR-011).
 */
function containedRegularFile(realRoot: string, relativePath: string): string | undefined {
  if (path.isAbsolute(relativePath) || relativePath.split('/').includes('..')) return undefined;
  const absolutePath = path.join(realRoot, relativePath);
  try {
    if (!fs.lstatSync(absolutePath).isFile()) return undefined;
    const real = fs.realpathSync(absolutePath);
    const relative = path.relative(realRoot, real);
    if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return undefined;
    }
    return real;
  } catch {
    return undefined;
  }
}

/** The registry's definition of a content change, or undefined when the file is no longer a regular file. */
function md5File(absolutePath: string): string | undefined {
  const content = readRegularFileNoFollow(absolutePath);
  return content === undefined ? undefined : crypto.createHash('md5').update(content).digest('hex');
}

/**
 * Reads a file only if it is still a regular file when opened.
 *
 * `containedRegularFile` checks the path, and this read happens after it; a
 * file swapped for a symlink in between would otherwise be followed outside
 * the worktree. `O_NOFOLLOW` makes the open itself refuse a symlink, and the
 * check runs on the descriptor that is read.
 *
 * @param absolutePath - A path already resolved inside the worktree.
 * @returns The content, or undefined when the path is no longer a regular file.
 */
export function readRegularFileNoFollow(absolutePath: string): string | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(absolutePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    if (!fs.fstatSync(descriptor).isFile()) return undefined;
    return fs.readFileSync(descriptor, 'utf-8');
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

/** Same rule as `WorkspaceDiscoveryService.artifactKindOf`, for a path the index already holds. */
function artifactKindOf(relativePath: string): WorkspaceArtifactKind {
  const normalized = relativePath.toLowerCase();
  return normalized.endsWith('/prisma/schema.prisma') || normalized === 'prisma/schema.prisma' ? 'prisma-schema' : 'typescript';
}

/** Discovery's verdict on new paths, cached until the head or the set of new paths changes. */
function discoveredScope(
  root: string,
  head: string | undefined,
  unindexed: readonly string[],
  discover: ((root: string) => WorkspaceDiscovery) | undefined,
): ReadonlyMap<string, WorkspaceArtifactKind> {
  // The paths alone are not enough: a tsconfig already modified in the
  // worktree stays in the list when it is edited again, and that edit can
  // bring a new file into scope. Size and mtime of each path change with it.
  const key = `${head ?? ''}\0${unindexed.map((relativePath) => `${relativePath}@${statStamp(path.join(root, relativePath))}`).join('\0')}`;
  const cached = discoveryCache.get(root);
  if (cached !== undefined && cached.key === key) return cached.files;
  let files: Map<string, WorkspaceArtifactKind>;
  try {
    const discovery = (discover ?? ((candidate: string) => new WorkspaceDiscoveryService(candidate).discover()))(root);
    files = new Map(discovery.sourceFiles.map((file) => [file.relativePath, file.kind]));
  } catch {
    // A worktree discovery cannot read has no new source in scope; the paths the
    // index already holds were decided above without it.
    files = new Map();
  }
  discoveryCache.set(root, { key, files });
  return files;
}
