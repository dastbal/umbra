import { summarizeTurnAudits } from './metrics';
import type { TurnAuditRecord } from '../../presentation/cli/turn-audit';

const record = (outcome: TurnAuditRecord['outcome'], elapsedMs: number): TurnAuditRecord => ({
  schemaVersion: 1,
  auditId: `${outcome}-${elapsedMs}`,
  startedAt: '2026-08-25T00:00:00.000Z',
  elapsedMs,
  mode: 'deep',
  model: 'gemini-2.5-flash-lite',
  threadHash: 'safehash',
  recursionLimit: 50,
  toolBudget: 8,
  toolCalls: 0,
  tools: [],
  toolDurationsMs: {},
  textOutput: outcome === 'completed',
  outcome,
});

describe('summarizeTurnAudits', () => {
  it('returns safe defaults when no local telemetry exists', () => {
    expect(summarizeTurnAudits([])).toEqual({
      total: 0,
      completed: 0,
      blocked: 0,
      failed: 0,
      completionRate: 1,
      toolErrorRate: 0,
      p50ElapsedMs: 0,
      p95ElapsedMs: 0,
    });
  });

  it('calculates completion, error rates, and nearest-rank durations', () => {
    const metrics = summarizeTurnAudits([
      record('completed', 10),
      record('completed', 20),
      record('recursion_limit', 30),
      record('error', 100),
    ]);

    expect(metrics.completed).toBe(2);
    expect(metrics.blocked).toBe(1);
    expect(metrics.failed).toBe(1);
    expect(metrics.completionRate).toBe(0.5);
    expect(metrics.toolErrorRate).toBe(0.25);
    expect(metrics.p50ElapsedMs).toBe(20);
    expect(metrics.p95ElapsedMs).toBe(100);
  });
});
