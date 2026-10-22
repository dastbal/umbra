import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseWorktreeList, resolveWorktree, WorktreeResolutionError } from './git-worktrees';

/** Runs git in a fixture repository with an identity, so commits work on any machine. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
  });
}

describe('parseWorktreeList', () => {
  it('reads paths, heads, branches and flags from NUL-terminated porcelain', () => {
    const output = [
      'worktree /repo', 'HEAD aaa', 'branch refs/heads/main', '',
      'worktree /repo/.claude/worktrees/x', 'HEAD bbb', 'detached', '',
      'worktree /gone', 'HEAD ccc', 'branch refs/heads/old', 'prunable gitdir file points to non-existent location', '',
    ].join('\0');

    expect(parseWorktreeList(output)).toEqual([
      { path: '/repo', head: 'aaa', branch: 'main', bare: false, prunable: false },
      { path: '/repo/.claude/worktrees/x', head: 'bbb', branch: undefined, bare: false, prunable: false },
      { path: '/gone', head: 'ccc', branch: 'old', bare: false, prunable: true },
    ]);
  });

  it('keeps a path that contains a newline as one path', () => {
    expect(parseWorktreeList('worktree /a\nb\0HEAD aaa\0\0')[0]?.path).toBe('/a\nb');
  });
});

describe('resolveWorktree', () => {
  let base: string;
  let repo: string;
  let linked: string;

  beforeAll(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-worktrees-')));
    repo = path.join(base, 'repo');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    // Claude Code's own layout: the linked worktree lives inside the main checkout.
    linked = path.join(repo, '.claude', 'worktrees', 'feature');
    git(repo, 'worktree', 'add', '-q', '-b', 'feature', linked);
  });

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('selects the pinned root itself', async () => {
    await expect(resolveWorktree(repo, repo)).resolves.toMatchObject({ root: repo, isPinnedRoot: true, branch: 'main' });
  });

  it('selects a linked worktree nested inside the main checkout, not the checkout around it', async () => {
    await expect(resolveWorktree(repo, linked)).resolves.toMatchObject({ root: linked, isPinnedRoot: false, branch: 'feature' });
  });

  it('maps a subdirectory of a worktree to that worktree', async () => {
    await expect(resolveWorktree(repo, path.join(linked, 'src'))).resolves.toMatchObject({ root: linked });
  });

  it('refuses a relative path', async () => {
    await expect(resolveWorktree(repo, 'src')).rejects.toMatchObject({ code: 'WORKTREE_NOT_ABSOLUTE' });
  });

  it('refuses a path that does not exist', async () => {
    await expect(resolveWorktree(repo, path.join(base, 'missing'))).rejects.toMatchObject({ code: 'WORKTREE_NOT_FOUND' });
  });

  it('refuses a directory outside every registered worktree', async () => {
    const outside = fs.mkdtempSync(path.join(base, 'outside-'));
    await expect(resolveWorktree(repo, outside)).rejects.toBeInstanceOf(WorktreeResolutionError);
    await expect(resolveWorktree(repo, outside)).rejects.toMatchObject({ code: 'WORKTREE_NOT_REGISTERED' });
  });

  it('refuses a symlink inside the checkout that points outside it', async () => {
    const outside = fs.mkdtempSync(path.join(base, 'target-'));
    const link = path.join(repo, 'escape');
    fs.symlinkSync(outside, link);
    try {
      await expect(resolveWorktree(repo, link)).rejects.toMatchObject({ code: 'WORKTREE_NOT_REGISTERED' });
    } finally {
      fs.unlinkSync(link);
    }
  });

  it('refuses a `..` path that leaves the worktree', async () => {
    await expect(resolveWorktree(repo, path.join(repo, '..'))).rejects.toMatchObject({ code: 'WORKTREE_NOT_REGISTERED' });
  });

  it('refuses a worktree of another repository', async () => {
    const other = path.join(base, 'other');
    fs.mkdirSync(other);
    git(other, 'init', '-q');
    await expect(resolveWorktree(repo, other)).rejects.toMatchObject({ code: 'WORKTREE_NOT_REGISTERED' });
  });

  it('reports git failure as a typed refusal', async () => {
    const failingGit = async (): Promise<string> => {
      throw new Error('spawn git ENOENT');
    };
    await expect(resolveWorktree(repo, repo, failingGit)).rejects.toMatchObject({ code: 'WORKTREE_GIT_UNAVAILABLE' });
  });
});

describe('resolveWorktree at the repository boundary', () => {
  let base: string;
  let other: string;

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-worktree-boundary-')));
    other = path.join(base, 'other');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 'secret.ts'), 'export const secret = 1;\n');
    git(other, 'init', '-q', '-b', 'main');
    git(other, 'add', '.');
    git(other, 'commit', '-q', '-m', 'other');
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  /** A repository whose `.gitmodules` declares `sub`, with `sub` left to the caller to create. */
  const pinnedWithDeclaredSubmodule = (): string => {
    const pinned = path.join(base, 'pinned');
    fs.mkdirSync(pinned);
    fs.writeFileSync(path.join(pinned, 'package.json'), '{}');
    fs.writeFileSync(path.join(pinned, '.gitmodules'), '[submodule "sub"]\n\tpath = sub\n\turl = ../other\n');
    git(pinned, 'init', '-q', '-b', 'main');
    return pinned;
  };

  it('refuses a submodule path that is a symlink to another repository', async () => {
    const pinned = pinnedWithDeclaredSubmodule();
    fs.symlinkSync(other, path.join(pinned, 'sub'));
    git(pinned, 'add', '.');
    git(pinned, 'commit', '-q', '-m', 'pinned');
    await expect(resolveWorktree(pinned, other)).rejects.toMatchObject({ code: 'WORKTREE_NOT_REGISTERED' });
  });

  it('refuses a submodule whose .git file points at another repository', async () => {
    const pinned = pinnedWithDeclaredSubmodule();
    fs.mkdirSync(path.join(pinned, 'sub'));
    fs.writeFileSync(path.join(pinned, 'sub', '.git'), `gitdir: ${path.join(other, '.git')}\n`);
    git(pinned, 'add', '.gitmodules', 'package.json');
    git(pinned, 'commit', '-q', '-m', 'pinned');
    await expect(resolveWorktree(pinned, other)).rejects.toMatchObject({ code: 'WORKTREE_NOT_REGISTERED' });
  });

  it('refuses any selection when the served root is a subdirectory of its repository', async () => {
    const mono = path.join(base, 'mono');
    fs.mkdirSync(path.join(mono, 'packages', 'app'), { recursive: true });
    fs.mkdirSync(path.join(mono, 'secret'));
    fs.writeFileSync(path.join(mono, 'packages', 'app', 'package.json'), '{}');
    fs.writeFileSync(path.join(mono, 'secret', 'notes.txt'), 'sibling\n');
    git(mono, 'init', '-q', '-b', 'main');
    git(mono, 'add', '.');
    git(mono, 'commit', '-q', '-m', 'mono');
    const pinned = path.join(mono, 'packages', 'app');
    await expect(resolveWorktree(pinned, pinned)).rejects.toMatchObject({ code: 'WORKTREE_PINNED_SUBDIRECTORY' });
    await expect(resolveWorktree(pinned, path.join(mono, 'secret'))).rejects.toMatchObject({ code: 'WORKTREE_PINNED_SUBDIRECTORY' });
  });
});
