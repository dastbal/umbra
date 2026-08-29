import * as fs from 'fs';
import * as path from 'path';
import type { TurnAuditRecord } from '../../presentation/cli/turn-audit';
import { agentPath } from '../config/agent-directory';

/** Aggregate, privacy-safe operational metrics derived from local turn audits. */
export interface AgentMetrics {
  total: number;
  completed: number;
  blocked: number;
  failed: number;
  completionRate: number;
  toolErrorRate: number;
  p50ElapsedMs: number;
  p95ElapsedMs: number;
  /**
   * What these turns cost in USD, summed over the ones the provider priced.
   *
   * The file has carried a per-turn `costUsd` since ADR-019 and this summary
   * never added it up, so "what did this week cost?" still had no answer with
   * the data in hand.
   */
  costUsd: number;
  /**
   * The slice of {@link AgentMetrics.costUsd} spent on reasoning the operator
   * never saw. **Part of that total, not additional.**
   *
   * This is the number the whole measurement exists for. Since the ADR-006
   * amendment the model's thinking is generated, billed and never printed, and
   * the honest way to decide whether that is worth paying for is to read it
   * rather than estimate it.
   */
  reasoningCostUsd: number;
  /** Reasoning tokens over the same turns; already inside their completion tokens. */
  reasoningTokens: number;
  /**
   * How many turns actually reported a thinking share.
   *
   * Published beside the sums because it is the sample size. Anthropic reports
   * no breakdown in the installed version, so a session on Claude yields
   * `reasoningCostUsd: 0` from *silence*, not from a model that did not think —
   * and a zero with no sample beside it would read as the opposite.
   */
  turnsReportingReasoning: number;
}

/** Loads audit records created since the supplied date without exposing raw content. */
export function loadTurnAudits(rootDir: string, since: Date): TurnAuditRecord[] {
  const auditPath = agentPath(rootDir, 'telemetry', 'interactive-turns.jsonl');
  if (!fs.existsSync(auditPath)) return [];

  return fs.readFileSync(auditPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const record = JSON.parse(line) as TurnAuditRecord;
        return new Date(record.startedAt) >= since ? [record] : [];
      } catch {
        return [];
      }
    });
}

/** Summarizes local audit records into stable operational metrics. */
export function summarizeTurnAudits(records: TurnAuditRecord[]): AgentMetrics {
  const completed = records.filter((record) => record.outcome === 'completed').length;
  const blocked = records.filter((record) => record.outcome === 'recursion_limit').length;
  const failed = records.length - completed - blocked;
  const toolFailures = records.filter((record) => record.outcome === 'error' || record.outcome === 'provider_400_recovered').length;
  const durations = records.map((record) => record.elapsedMs).sort((left, right) => left - right);

  return {
    total: records.length,
    completed,
    blocked,
    failed,
    completionRate: records.length === 0 ? 1 : completed / records.length,
    toolErrorRate: records.length === 0 ? 0 : toolFailures / records.length,
    p50ElapsedMs: percentile(durations, 0.5),
    p95ElapsedMs: percentile(durations, 0.95),
    costUsd: sum(records.map((record) => record.costUsd)),
    reasoningCostUsd: sum(records.map((record) => record.reasoningCostUsd)),
    reasoningTokens: sum(records.map((record) => record.reasoningTokens)),
    turnsReportingReasoning: records.filter(
      (record) => record.reasoningTokens !== undefined,
    ).length,
  };
}

/**
 * Adds the reported values in a column, ignoring the turns that reported none.
 *
 * An unreported turn contributes nothing rather than a zero, so a sum is never
 * diluted by turns whose provider stayed silent.
 *
 * @param values - One column of the audit records, with gaps.
 * @returns The total over the values that exist.
 */
function sum(values: Array<number | undefined>): number {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

/** Returns a nearest-rank percentile for a sorted number sequence. */
function percentile(sortedValues: number[], percentileValue: number): number {
  if (sortedValues.length === 0) return 0;
  return sortedValues[Math.ceil(percentileValue * sortedValues.length) - 1];
}
