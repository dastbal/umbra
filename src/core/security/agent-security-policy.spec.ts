import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgentSecurityPolicy, resolveWorkspacePath } from './agent-security-policy';

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
