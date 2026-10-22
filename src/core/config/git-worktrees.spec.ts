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
