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
      costUsd: 0,
      reasoningCostUsd: 0,
      reasoningTokens: 0,
      turnsReportingReasoning: 0,
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

  describe('what the turns cost, and how much of it was thinking', () => {
    const priced = (
      costUsd: number,
      reasoning?: { tokens: number; costUsd: number },
    ): TurnAuditRecord => ({
      ...record('completed', 10),
      auditId: `priced-${costUsd}-${reasoning?.tokens ?? 'none'}`,
      tokens: 5_000,
      costUsd,
      ...(reasoning === undefined ? {} : {
        reasoningTokens: reasoning.tokens,
        reasoningCostUsd: reasoning.costUsd,
      }),
    });

    it('adds up the cost the file has carried since ADR-019 and never summed', () => {
      const metrics = summarizeTurnAudits([
        priced(0.0040, { tokens: 1_200, costUsd: 0.0012 }),
        priced(0.0020, { tokens: 300, costUsd: 0.0003 }),
      ]);

      expect(metrics.costUsd).toBeCloseTo(0.0060, 6);
      expect(metrics.reasoningCostUsd).toBeCloseTo(0.0015, 6);
      expect(metrics.reasoningTokens).toBe(1_500);
      expect(metrics.turnsReportingReasoning).toBe(2);
    });

    it('publishes the sample size beside the sums, so a silent provider reads as silent', () => {
      // Anthropic reports no breakdown. Without the count, its zero would be
      // indistinguishable from a model that thought nothing.
      const metrics = summarizeTurnAudits([priced(0.0040), priced(0.0020)]);

      expect(metrics.costUsd).toBeCloseTo(0.0060, 6);
      expect(metrics.reasoningCostUsd).toBe(0);
      expect(metrics.turnsReportingReasoning).toBe(0);
    });

    it('is not diluted by turns the provider never priced', () => {
      const metrics = summarizeTurnAudits([
        priced(0.0040, { tokens: 1_200, costUsd: 0.0012 }),
        record('completed', 10),
      ]);

      expect(metrics.costUsd).toBeCloseTo(0.0040, 6);
      expect(metrics.turnsReportingReasoning).toBe(1);
    });
  });
});
