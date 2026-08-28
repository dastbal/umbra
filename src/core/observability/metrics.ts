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
  };
}

/** Returns a nearest-rank percentile for a sorted number sequence. */
function percentile(sortedValues: number[], percentileValue: number): number {
  if (sortedValues.length === 0) return 0;
  return sortedValues[Math.ceil(percentileValue * sortedValues.length) - 1];
}
