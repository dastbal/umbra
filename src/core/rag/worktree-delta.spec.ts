import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { computeWorktreeDelta, resetWorktreeDeltaCache } from './worktree-delta';
import { mergeIndexedGitState } from './indexed-git-state';

/**
 * Delta detection against a registry, without an index run: the registry rows
 * are written by hand from the main checkout's files, which is exactly what an
 * index run would record.
 */

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
}

function md5(content: string): string {
  return crypto.createHash('md5').update(content).digest('hex');
}

describe('computeWorktreeDelta', () => {
  let base: string;
  let repo: string;
  let linked: string;
  let db: Database.Database;

  const register = (relativePath: string, content: string): void => {
    db.prepare('INSERT OR REPLACE INTO file_registry (path, hash) VALUES (?, ?)').run(relativePath, md5(content));
  };
  const writeIn = (root: string, relativePath: string, content: string): void => {
    fs.mkdirSync(path.dirname(path.join(root, relativePath)), { recursive: true });
    fs.writeFileSync(path.join(root, relativePath), content, 'utf8');
  };

  beforeEach(() => {
    resetWorktreeDeltaCache();
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-delta-')));
    repo = path.join(base, 'repo');
    writeIn(repo, 'package.json', '{}');
    writeIn(repo, 'tsconfig.json', '{"include":["src/**/*.ts"]}');
    writeIn(repo, '.gitignore', 'src/generated/\n');
    writeIn(repo, 'src/a.ts', 'export const a = 1;\n');
    writeIn(repo, 'src/b.ts', 'export const b = 1;\n');
    writeIn(repo, 'src/generated/client.ts', 'export const generated = 1;\n');
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    linked = path.join(base, 'linked');
    git(repo, 'worktree', 'add', '-q', '-b', 'feature', linked);

    db = new Database(':memory:');
    db.exec('CREATE TABLE file_registry (path TEXT PRIMARY KEY, hash TEXT, last_indexed INTEGER)');
    register('src/a.ts', 'export const a = 1;\n');
    register('src/b.ts', 'export const b = 1;\n');
    register('src/generated/client.ts', 'export const generated = 1;\n');
  });

  afterEach(() => {
    db.close();
    fs.rmSync(base, { recursive: true, force: true });
  });

  const delta = () => computeWorktreeDelta({ repositoryRoot: repo, worktreeRoot: linked, db });

  it('is empty for a worktree identical to the index, even without the gitignored artifacts the index holds', async () => {
    // The generated client is gitignored, so the linked worktree never got it.
    // An environment artifact the worktree has not produced is not a deletion.
    const result = await delta();
    expect(result.changed).toEqual([]);
    expect(result.deleted).toEqual([]);
  });

  it('hides an untracked file of the main checkout that git reports, because it is that checkout\'s work in progress', async () => {
    writeIn(repo, 'src/draft.ts', 'export const draft = 1;\n');
    register('src/draft.ts', 'export const draft = 1;\n');
    expect((await delta()).deleted).toEqual(['src/draft.ts']);
  });

  it('reports a gitignored file the index holds, when the worktree has another version', async () => {
    writeIn(linked, 'src/generated/client.ts', 'export const generated = 2;\n');
    expect((await delta()).changed.map((file) => file.relativePath)).toEqual(['src/generated/client.ts']);
  });

  it('reports both sides of a rename, never just the new path', async () => {
    git(linked, 'mv', 'src/a.ts', 'src/renamed.ts');
    git(linked, 'commit', '-q', '-m', 'rename');
    const result = await delta();
    expect(result.changed.map((file) => file.relativePath)).toContain('src/renamed.ts');
    expect(result.deleted).toContain('src/a.ts');
  });

  it('drops a candidate whose content git reports but the hash shows unchanged', async () => {
    writeIn(linked, 'src/b.ts', 'export const b = 2;\n');
    writeIn(linked, 'src/b.ts', 'export const b = 1;\n');
    // Touched, then restored: git may list it; the registry hash decides.
    expect((await delta()).changed.map((file) => file.relativePath)).not.toContain('src/b.ts');
  });

  it('never reads through a symlink, and hides the indexed file it replaced', async () => {
    const secret = path.join(base, 'secret.ts');
    fs.writeFileSync(secret, 'export const secret = "do not read";\n');
    fs.rmSync(path.join(linked, 'src/b.ts'));
    fs.symlinkSync(secret, path.join(linked, 'src/b.ts'));
    const result = await delta();
    expect(result.changed.map((file) => file.relativePath)).not.toContain('src/b.ts');
    expect(result.deleted).toContain('src/b.ts');
  });

  it('scopes a new file by discovery, so a spec or a file outside the tsconfig is not source', async () => {
    writeIn(linked, 'src/new.ts', 'export const fresh = 1;\n');
    writeIn(linked, 'src/new.spec.ts', 'it("x", () => undefined);\n');
    writeIn(linked, 'scripts/tool.ts', 'export const tool = 1;\n');
    expect((await delta()).changed.map((file) => file.relativePath)).toEqual(['src/new.ts']);
  });

  it('changes its signature exactly when the overlay must change', async () => {
    const first = (await delta()).signature;
    expect((await delta()).signature).toBe(first);
    writeIn(linked, 'src/a.ts', 'export const a = 2;\n');
    expect((await delta()).signature).not.toBe(first);
  });
});

describe('mergeIndexedGitState', () => {
  it('keeps the starting head and unions every path that may hold an uncommitted version', () => {
    expect(mergeIndexedGitState(
      { head: 'aaa', dirty: ['src/a.ts'] },
      { head: 'bbb', dirty: ['src/b.ts'] },
      ['src/pending.ts'],
    )).toEqual({ head: 'aaa', dirty: ['src/a.ts', 'src/b.ts', 'src/pending.ts'] });
  });

  it('records nothing outside git', () => {
    expect(mergeIndexedGitState(undefined, undefined, ['src/a.ts'])).toBeUndefined();
  });
});
