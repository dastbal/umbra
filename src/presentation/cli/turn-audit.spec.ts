import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TurnAudit, type TurnAuditRecord } from './turn-audit';
import { AGENT_DIR_NAME } from '../../core/config/agent-directory';
import { KERNEL_API_VERSION } from '../../core/agent/agent-kernel';

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
        join(rootDir, AGENT_DIR_NAME, 'telemetry', 'interactive-turns.jsonl'),
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

  it('keeps kernel role metadata safe enough for local telemetry and trace correlation', () => {
    const audit = new TurnAudit({
      rootDir: tmpdir(),
      mode: 'orchestrate',
      model: 'gemini-3.5-flash',
      threadId: 'thread',
      recursionLimit: 50,
      kernel: {
        kernelVersion: KERNEL_API_VERSION,
        roles: [{
          kernelVersion: KERNEL_API_VERSION,
          roleId: 'security-reviewer',
          capabilities: ['read_code'],
          workflowRole: 'advisory',
        }],
      },
    });

    expect(audit.getTraceMetadata()).toMatchObject({
      agent_kernel_version: KERNEL_API_VERSION,
      agent_role_ids: ['security-reviewer'],
    });
  });
});

describe('the turn price survives the screen', () => {
  /** Runs one audited turn and returns the record it wrote. */
  function auditedTurn(spend: { tokens: number; costUsd?: number }): Record<string, unknown> {
    const rootDir = mkdtempSync(join(tmpdir(), 'nestjs-agent-turn-spend-'));
    const audit = new TurnAudit({
      rootDir,
      mode: 'orchestrate',
      model: 'gemini-2.5-flash-lite',
      threadId: 'a-session',
      recursionLimit: 50,
    });

    audit.recordSpend(spend.tokens, spend.costUsd);
    audit.record('completed');

    const line = readFileSync(
      join(rootDir, AGENT_DIR_NAME, 'telemetry', 'interactive-turns.jsonl'),
      'utf8',
    ).trim();

    return JSON.parse(line) as Record<string, unknown>;
  }

  it('records what the turn spent, which the record never carried', () => {
    // Until now the JSONL held tool calls and elapsed time and no cost at all,
    // so a day of work could not be priced even with the file in hand. The one
    // counter that existed lived on the wait indicator and was erased with it.
    const record = auditedTurn({ tokens: 12_400, costUsd: 0.0041 });

    expect(record['tokens']).toBe(12_400);
    expect(record['costUsd']).toBeCloseTo(0.0041, 6);
  });

  it('omits the cost for an unpriced model rather than storing zero', () => {
    // A stored 0.00 cannot be told apart from a free turn, and reporting zero
    // for a real spend is the failure ADR-019 started from.
    const record = auditedTurn({ tokens: 900 });

    expect(record['tokens']).toBe(900);
    expect(record).not.toHaveProperty('costUsd');
  });

  it('omits a token count the provider never reported', () => {
    expect(auditedTurn({ tokens: 0 })).not.toHaveProperty('tokens');
  });

  it('still carries no prompt, tool argument or file content', () => {
    const record = auditedTurn({ tokens: 12_400, costUsd: 0.0041 });

    expect(JSON.stringify(record)).not.toMatch(/prompt|content|args/i);
  });
});
