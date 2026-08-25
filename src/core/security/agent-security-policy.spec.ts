import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { AgentSecurityPolicy, resolveWorkspacePath } from './agent-security-policy';

/**
 * Probes whether this machine can create *file* symlinks.
 *
 * Windows refuses them without elevation or Developer Mode, while directory
 * junctions work unprivileged. Probing once lets the escape cases run in CI
 * (Linux) and skip cleanly on a developer's Windows box instead of failing.
 */
function canSymlinkFiles(): boolean {
  const probe = mkdtempSync(join(tmpdir(), 'agent-policy-probe-'));
  try {
    writeFileSync(join(probe, 'target.txt'), 'probe', 'utf8');
    symlinkSync(join(probe, 'target.txt'), join(probe, 'link.txt'), 'file');
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

const itWithFileSymlinks = canSymlinkFiles() ? it : it.skip;

describe('AgentSecurityPolicy', () => {
  const policy = new AgentSecurityPolicy();
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'agent-policy-'));
    mkdirSync(join(rootDir, 'src'));
    mkdirSync(join(rootDir, 'docs'));
    mkdirSync(join(rootDir, '.github'));
    writeFileSync(join(rootDir, 'package.json'), '{}', 'utf8');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('allows non-sensitive workspace reads', () => {
    expect(policy.evaluate({ kind: 'read_file', rootDir, targetPath: 'src/app.ts' }).decision).toBe('allow');
  });

  it('allows source, test, and documentation writes', () => {
    expect(policy.evaluate({ kind: 'write_file', rootDir, targetPath: 'src/app.ts' }).decision).toBe('allow');
    expect(policy.evaluate({ kind: 'write_file', rootDir, targetPath: 'tests/app.spec.ts' }).decision).toBe('allow');
    expect(policy.evaluate({ kind: 'write_file', rootDir, targetPath: 'docs/guide.md' }).decision).toBe('allow');
  });

  it('requires approval for project configuration and CI files', () => {
    expect(policy.evaluate({ kind: 'write_file', rootDir, targetPath: 'package.json' }).decision).toBe('require_approval');
    expect(policy.evaluate({ kind: 'write_file', rootDir, targetPath: '.github/workflows/ci.yml' }).decision).toBe('require_approval');
  });

  it('denies environment files and repository metadata', () => {
    expect(policy.evaluate({ kind: 'read_file', rootDir, targetPath: '.env' }).decision).toBe('deny');
    expect(policy.evaluate({ kind: 'write_file', rootDir, targetPath: '.git/config' }).decision).toBe('deny');
  });

  it('denies paths outside the workspace and prefix-collision paths', () => {
    expect(policy.evaluate({ kind: 'read_file', rootDir, targetPath: '../outside.txt' }).decision).toBe('deny');
    expect(resolveWorkspacePath(rootDir, `${rootDir}-other/file.ts`)).toBeUndefined();
  });

  it('denies a path that escapes through a symlink', () => {
    const outside = mkdtempSync(join(tmpdir(), 'agent-policy-outside-'));
    try {
      symlinkSync(outside, join(rootDir, 'src', 'escape'), 'junction');
      expect(policy.evaluate({ kind: 'write_file', rootDir, targetPath: 'src/escape/file.ts' }).decision).toBe('deny');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  itWithFileSymlinks('denies a link in the final component that escapes the workspace', () => {
    const outside = mkdtempSync(join(tmpdir(), 'agent-policy-outside-'));
    try {
      writeFileSync(join(outside, 'secret.env'), 'TOKEN=1', 'utf8');
      symlinkSync(join(outside, 'secret.env'), join(rootDir, 'src', 'notes.txt'), 'file');
      expect(policy.evaluate({ kind: 'read_file', rootDir, targetPath: 'src/notes.txt' }).decision).toBe('deny');
      expect(resolveWorkspacePath(rootDir, 'src/notes.txt')).toBeUndefined();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  itWithFileSymlinks('denies a protected target reached through an innocuous link name', () => {
    writeFileSync(join(rootDir, '.env'), 'TOKEN=1', 'utf8');
    symlinkSync(join(rootDir, '.env'), join(rootDir, 'src', 'notes.txt'), 'file');
    expect(policy.evaluate({ kind: 'read_file', rootDir, targetPath: 'src/notes.txt' }).decision).toBe('deny');
  });

  itWithFileSymlinks('denies writing through a dangling link that points outside', () => {
    const outside = mkdtempSync(join(tmpdir(), 'agent-policy-dangling-'));
    try {
      symlinkSync(join(outside, 'created.ts'), join(rootDir, 'src', 'pending.ts'), 'file');
      expect(policy.evaluate({ kind: 'write_file', rootDir, targetPath: 'src/pending.ts' }).decision).toBe('deny');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  itWithFileSymlinks('allows a link that stays inside the workspace and resolves it', () => {
    writeFileSync(join(rootDir, 'src', 'real.ts'), 'export const a = 1;', 'utf8');
    symlinkSync(join(rootDir, 'src', 'real.ts'), join(rootDir, 'src', 'alias.ts'), 'file');
    expect(policy.evaluate({ kind: 'read_file', rootDir, targetPath: 'src/alias.ts' }).decision).toBe('allow');
    expect(resolveWorkspacePath(rootDir, 'src/alias.ts')).toBe(realpathSync.native(join(rootDir, 'src', 'real.ts')));
  });

  /**
   * The escape cases above need real file symlinks, which Windows refuses without
   * elevation. This one drives the same branch by intercepting the resolver, so
   * the guarantee is exercised on every platform and not only in CI.
   */
  it('denies a final component that resolves outside, on any platform', () => {
    const outside = mkdtempSync(join(tmpdir(), 'agent-policy-simulated-'));
    const linkPath = join(rootDir, 'src', 'notes.txt');
    writeFileSync(linkPath, 'placeholder', 'utf8');
    const escapedTarget = join(outside, 'secret.env');
    writeFileSync(escapedTarget, 'TOKEN=1', 'utf8');

    // Compare against the *resolved* link path: on Windows `mkdtempSync` hands
    // back an 8.3 short path, so the raw join never equals what the policy sees.
    const realNative = realpathSync.native;
    const resolvedLink = realNative(linkPath);
    const spy = jest
      .spyOn(realpathSync, 'native')
      .mockImplementation(((candidate: string) =>
        resolve(String(candidate)) === resolve(resolvedLink)
          ? escapedTarget
          : realNative(candidate)) as typeof realpathSync.native);

    try {
      expect(policy.evaluate({ kind: 'read_file', rootDir, targetPath: 'src/notes.txt' }).decision).toBe('deny');
      expect(resolveWorkspacePath(rootDir, 'src/notes.txt')).toBeUndefined();
    } finally {
      spy.mockRestore();
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('resolves a plain existing file to its real path', () => {
    writeFileSync(join(rootDir, 'src', 'app.ts'), 'export const a = 1;', 'utf8');
    expect(resolveWorkspacePath(rootDir, 'src/app.ts')).toBe(realpathSync.native(join(rootDir, 'src', 'app.ts')));
  });

  it('still resolves a path that does not exist yet, for file creation', () => {
    expect(resolveWorkspacePath(rootDir, 'src/new-file.ts')).toBeDefined();
    expect(policy.evaluate({ kind: 'write_file', rootDir, targetPath: 'src/new-file.ts' }).decision).toBe('allow');
  });

  it('requires approval for deletes and arbitrary execution', () => {
    expect(policy.evaluate({ kind: 'delete_file', rootDir, targetPath: 'src/app.ts' }).decision).toBe('require_approval');
    expect(policy.evaluate({ kind: 'execute_command', rootDir, command: 'git status' }).decision).toBe('require_approval');
  });

  it('allows only fixed verification actions', () => {
    expect(policy.evaluate({ kind: 'run_test', rootDir }).decision).toBe('allow');
    expect(policy.evaluate({ kind: 'run_type_check', rootDir }).decision).toBe('allow');
    expect(policy.evaluate({ kind: 'run_lint', rootDir }).decision).toBe('allow');
  });
});
