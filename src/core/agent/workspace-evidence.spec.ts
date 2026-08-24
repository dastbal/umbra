import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  collectWorkspaceEvidence,
  formatWorkspaceEvidence,
} from './workspace-evidence';

describe('workspace evidence manifest', () => {
  it('collects only existing files and includes line-numbered evidence', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'nestjs-agent-evidence-'));
    try {
      mkdirSync(join(rootDir, 'src', 'core'), { recursive: true });
      writeFileSync(
        join(rootDir, 'src', 'core', 'agent.ts'),
        'export class AgentFactory {}\npublic static create() {}\n',
        'utf8',
      );

      const evidence = collectWorkspaceEvidence(rootDir, [
        { path: 'src/core/agent.ts', patterns: ['AgentFactory', 'static create'] },
        { path: 'src/core/missing.ts', patterns: ['anything'] },
      ]);
      const formatted = formatWorkspaceEvidence(evidence);

      expect(evidence.files).toEqual(['src/core/agent.ts']);
      expect(formatted).toContain('src/core/agent.ts:1');
      expect(formatted).toContain('export class AgentFactory');
      expect(formatted).not.toContain('src/core/missing.ts');
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('does not expose full unrelated file contents', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'nestjs-agent-evidence-small-'));
    try {
      writeFileSync(
        join(rootDir, 'package.json'),
        '{"name":"agent","secret":"should-not-be-included","scripts":{"test":"jest"}}',
        'utf8',
      );

      const evidence = collectWorkspaceEvidence(rootDir, [
        { path: 'package.json', patterns: ['scripts', 'test'] },
      ]);
      const formatted = formatWorkspaceEvidence(evidence);

      expect(formatted).toContain('package.json');
      expect(formatted).not.toContain('should-not-be-included');
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
