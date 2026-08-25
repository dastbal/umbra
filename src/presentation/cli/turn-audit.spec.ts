import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TurnAudit, type TurnAuditRecord } from './turn-audit';

describe('TurnAudit', () => {
  it('persists safe metrics without prompts, tool arguments, or raw errors', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'nestjs-agent-turn-audit-'));
    try {
      const audit = new TurnAudit({
        rootDir,
        mode: 'deep',
        model: 'gemini-3.5-flash',
        threadId: 'named-session-with-sensitive-context',
        recursionLimit: 50,
      });
      audit.recordToolStart('ask_codebase');
      audit.recordToolEnd('ask_codebase');
      audit.markTextOutput();
      audit.record('recursion_limit', 'Recursion limit of 50 reached with secret-like text');

      const line = readFileSync(
        join(rootDir, '.agent', 'telemetry', 'interactive-turns.jsonl'),
        'utf8',
      ).trim();
      const record = JSON.parse(line) as TurnAuditRecord;

      expect(record.outcome).toBe('recursion_limit');
      expect(record.errorCategory).toBe('recursion_limit');
      expect(record.toolCalls).toBe(1);
      expect(record.tools).toEqual(['ask_codebase']);
      expect(record.threadHash).not.toContain('named-session');
      expect(line).not.toContain('secret-like text');
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('builds metadata that joins a LangSmith trace to the local record', () => {
    const audit = new TurnAudit({
      rootDir: tmpdir(),
      mode: 'deep',
      model: 'gemini-3.5-flash',
      threadId: 'thread',
      recursionLimit: 50,
    });

    const metadata = audit.getTraceMetadata();

    expect(metadata.agent_audit_id).toEqual(expect.any(String));
    expect(metadata.agent_recursion_limit).toBe(50);
    expect(metadata.agent_tool_budget).toBe(8);
  });
});
