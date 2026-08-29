import { appendFileSync, mkdirSync } from 'fs';
import { createHash, randomUUID } from 'crypto';
import * as path from 'path';
import { DEFAULT_INTERACTIVE_TOOL_BUDGET } from '../../core/agent/iteration-budget.middleware';
import { extractProviderDiagnostic, writeProviderDiagnostic } from './provider-diagnostics';
import { agentPath } from '../../core/config/agent-directory';
import type { AgentKernelTelemetry } from '../../core/agent/agent-kernel';

/** Terminal outcome captured for one interactive agent turn. */
export type TurnAuditOutcome =
  | 'completed'
  | 'empty_response_retry'
  | 'empty_model_retry'
  | 'recursion_limit'
  | 'provider_400_recovered'
  | 'error';

/** Stable, privacy-safe metadata sent with the LangSmith trace. */
export interface TurnTraceMetadata {
  agent_audit_id: string;
  agent_mode: 'deep' | 'orchestrate';
  agent_model: string;
  agent_recursion_limit: number;
  agent_tool_budget: number;
  agent_kernel_version?: number;
  agent_role_ids?: string[];
}

/** Serialized local record used to audit interactive performance over time. */
export interface TurnAuditRecord {
  schemaVersion: 1;
  auditId: string;
  startedAt: string;
  elapsedMs: number;
  mode: 'deep' | 'orchestrate';
  model: string;
  threadHash: string;
  recursionLimit: number;
  toolBudget: number;
  toolCalls: number;
  tools: string[];
  toolDurationsMs: Record<string, number[]>;
  textOutput: boolean;
  /**
   * Prompt plus completion tokens observed for the turn, when the provider
   * reported them. Absent rather than zero when it did not: a recorded zero
   * cannot be told apart from a turn that genuinely spent nothing.
   */
  tokens?: number;
  /**
   * Turn cost in USD, when the model has a published price. Omitted for an
   * unpriced model, because a stored 0.00 is what made cost tracking report
   * nothing for the starred default (ADR-019).
   */
  costUsd?: number;
  outcome: TurnAuditOutcome;
  errorCategory?: 'recursion_limit' | 'provider_400' | 'model_output' | 'other';
  /**
   * Workspace-relative path to a redacted provider request snapshot, when one
   * was captured. A **path**, never the payload: this record stays shareable.
   */
  providerDiagnosticFile?: string;
  /** Kernel and role metadata only; prompts, arguments, and file contents stay excluded. */
  kernel?: AgentKernelTelemetry;
}

/** Input required to initialize a privacy-safe interactive turn audit. */
export interface TurnAuditInput {
  rootDir: string;
  mode: 'deep' | 'orchestrate';
  model: string;
  threadId: string;
  recursionLimit: number;
  /** Metadata composed by the factory, when the session receives a kernel-built graph. */
  kernel?: AgentKernelTelemetry;
}

/**
 * Captures only operational metadata for one turn and writes it as JSONL below
 * `.umbra/telemetry/`. Prompts, tool arguments, responses, credentials, and
 * provider payloads are intentionally excluded.
 *
 * That exclusion is why a rejected provider request is *not* recorded here. When
 * one is captured it goes to its own file under `.umbra/diagnostics/`, and this
 * record carries only its path in `providerDiagnosticFile` — so the JSONL stays
 * safe to hand to someone else, which is what `umbra metrics` reads it as.
 */
export class TurnAudit {
  private readonly startedAtMs = Date.now();
  private readonly auditId = randomUUID();
  private readonly tools: string[] = [];
  private readonly toolStartTimes = new Map<string, number>();
  private readonly toolDurationsMs: Record<string, number[]> = {};
  private textOutput = false;
  private tokens?: number;
  private costUsd?: number;
  private recorded = false;

  /** @param input - Session-safe context for one interactive turn. */
  public constructor(private readonly input: TurnAuditInput) {}

  /** Returns metadata that lets LangSmith traces join with the local audit line. */
  public getTraceMetadata(): TurnTraceMetadata {
    return {
      agent_audit_id: this.auditId,
      agent_mode: this.input.mode,
      agent_model: this.input.model,
      agent_recursion_limit: this.input.recursionLimit,
      agent_tool_budget: DEFAULT_INTERACTIVE_TOOL_BUDGET,
      ...(this.input.kernel === undefined ? {} : {
        agent_kernel_version: this.input.kernel.kernelVersion,
        agent_role_ids: this.input.kernel.roles.map((role) => role.roleId),
      }),
    };
  }

  /** Records a tool name and begins timing it without storing its arguments. */
  public recordToolStart(toolName: string): void {
    this.tools.push(toolName);
    this.toolStartTimes.set(toolName, Date.now());
  }

  /** Records the elapsed duration for a completed tool invocation. */
  public recordToolEnd(toolName: string): void {
    const startedAt = this.toolStartTimes.get(toolName);
    this.toolStartTimes.delete(toolName);
    if (startedAt === undefined) return;

    const durations = this.toolDurationsMs[toolName] ?? [];
    durations.push(Date.now() - startedAt);
    this.toolDurationsMs[toolName] = durations;
  }

  /** Marks that the model emitted user-visible text. */
  public markTextOutput(): void {
    this.textOutput = true;
  }

  /**
   * Persists this turn exactly once. Telemetry must never make a user request
   * fail, so local filesystem failures are intentionally ignored.
   *
   * @param outcome - Final state of the interactive turn.
   * @param errorMessage - Optional provider/framework message used only for a coarse category.
   * @param error - Optional thrown value. When it carries a provider request
   * context, a redacted snapshot is written to its own file and only the path
   * appears in this record.
   */
  /**
   * Records what the turn spent, so the price survives the screen.
   *
   * Until now the JSONL held tool calls and elapsed time and no cost at all, so
   * a day of work could not be priced even with the file in hand. The counter
   * that did exist lived on the wait indicator and was erased with it.
   *
   * @param tokens - Prompt plus completion tokens observed.
   * @param costUsd - Turn cost, or undefined for an unpriced model.
   */
  public recordSpend(tokens: number, costUsd?: number): void {
    if (tokens > 0) this.tokens = tokens;
    if (costUsd !== undefined) this.costUsd = costUsd;
  }

  public record(outcome: TurnAuditOutcome, errorMessage?: string, error?: unknown): void {
    if (this.recorded) return;
    this.recorded = true;

    const diagnostic = error === undefined ? undefined : extractProviderDiagnostic(error);
    const diagnosticFile = diagnostic === undefined
      ? undefined
      : writeProviderDiagnostic(this.input.rootDir, this.auditId, diagnostic);

    const record: TurnAuditRecord = {
      schemaVersion: 1,
      auditId: this.auditId,
      startedAt: new Date(this.startedAtMs).toISOString(),
      elapsedMs: Date.now() - this.startedAtMs,
      mode: this.input.mode,
      model: this.input.model,
      threadHash: createHash('sha256').update(this.input.threadId).digest('hex').slice(0, 16),
      recursionLimit: this.input.recursionLimit,
      toolBudget: DEFAULT_INTERACTIVE_TOOL_BUDGET,
      toolCalls: this.tools.length,
      tools: [...this.tools],
      toolDurationsMs: this.toolDurationsMs,
      textOutput: this.textOutput,
      ...(this.tokens === undefined ? {} : { tokens: this.tokens }),
      ...(this.costUsd === undefined ? {} : { costUsd: this.costUsd }),
      outcome,
      ...(errorMessage ? { errorCategory: classifyError(errorMessage) } : {}),
      ...(diagnosticFile ? { providerDiagnosticFile: diagnosticFile } : {}),
      ...(this.input.kernel === undefined ? {} : { kernel: this.input.kernel }),
    };

    try {
      const telemetryDir = agentPath(this.input.rootDir, 'telemetry');
      mkdirSync(telemetryDir, { recursive: true });
      appendFileSync(path.join(telemetryDir, 'interactive-turns.jsonl'), `${JSON.stringify(record)}\n`, 'utf8');
    } catch {
      // Audit persistence is best effort; it must not affect agent execution.
    }
  }
}

/** Maps provider errors to safe categories instead of persisting raw text. */
function classifyError(errorMessage: string): TurnAuditRecord['errorCategory'] {
  if (errorMessage.includes('Recursion limit')) return 'recursion_limit';
  if (errorMessage.includes('status code 400')) return 'provider_400';
  if (errorMessage.includes('model output must contain')) return 'model_output';
  return 'other';
}
