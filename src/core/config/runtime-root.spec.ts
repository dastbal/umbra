import * as path from 'path';
import { pinRuntimeRoot, resetRuntimeRoot, runtimeRoot } from './runtime-root';

describe('runtime root', () => {
  afterEach(() => {
    resetRuntimeRoot();
  });

  it('falls back to the working directory, so no existing command changes behaviour', () => {
    expect(runtimeRoot()).toBe(process.cwd());
  });

  it('resolves a relative root to an absolute path', () => {
    pinRuntimeRoot('.');

    expect(path.isAbsolute(runtimeRoot())).toBe(true);
    expect(runtimeRoot()).toBe(path.resolve('.'));
  });

  it('tolerates pinning the same root twice, so a startup path that runs twice is harmless', () => {
    pinRuntimeRoot('/repos/alpha');

    expect(() => pinRuntimeRoot('/repos/alpha')).not.toThrow();
  });

  it('throws rather than silently serving the wrong repository', () => {
    // Two parts of the process disagreeing about which repository is served is
    // unrecoverable: `AgentDB` caches its connection on first use, so rows may
    // already have been read from the first root.
    pinRuntimeRoot('/repos/alpha');

    expect(() => pinRuntimeRoot('/repos/beta')).toThrow(/already pinned/);
  });

  it('names both roots in the failure, so the disagreement is diagnosable', () => {
    pinRuntimeRoot('/repos/alpha');

    expect(() => pinRuntimeRoot('/repos/beta')).toThrow(/beta/);
  });
});
