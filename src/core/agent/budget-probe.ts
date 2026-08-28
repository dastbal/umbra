import { appendFileSync, mkdirSync } from 'fs';
import * as path from 'path';
import { agentPath } from '../config/agent-directory';

/**
 * Environment flag that enables the turn-budget probe.
 *
 * Off by default, following the escape-hatch idiom already used by
 * `UMBRA_SIMPLE_PROMPT` and `UMBRA_SUBAGENT_QUESTIONS`: a diagnostic that has to
 * be remembered and deleted is a diagnostic that gets left behind.
 */
export const BUDGET_PROBE_ENV = 'UMBRA_BUDGET_PROBE';

/** Where the probe appends, relative to the workspace directory. */
export const BUDGET_PROBE_FILE = 'budget-probe.jsonl';

/**
 * One observation of what the iteration budget actually received.
 *
 * Deliberately shape-only. Message content, tool arguments and file paths are
 * never recorded: the question this probe answers is whether the state carries
 * countable tool calls, and that is answerable from counts alone.
 */
export interface BudgetProbeSample {
  /** Which hook produced the observation. */
  at: 'wrapModelCall' | 'wrapToolCall' | 'on_chat_model_end';
  /** Number of messages the hook was handed, when applicable. */
  messageCount?: number;
  /** Message discriminators in order, e.g. `['human', 'ai', 'tool']`. */
  messageTypes?: string[];
  /** How many messages carried a `tool_calls` array the counter can read. */
  messagesWithToolCallsArray?: number;
  /** What `countCurrentTurnToolCalls` returned for this state. */
  countedToolCalls?: number;
  /** Whether the budget would have forced a final response at this point. */
  wouldForceFinal?: boolean;
  /** Whether the model message carried `usage_metadata`. */
  hasUsageMetadata?: boolean;
  /** Keys present on `usage_metadata`, so the real field names are known. */
  usageKeys?: string[];
  /** Token counts when the provider supplied them. */
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/**
 * Reports whether the probe is enabled for this process.
 *
 * @returns True when {@link BUDGET_PROBE_ENV} is set to `1`.
 */
export function isBudgetProbeEnabled(): boolean {
  return process.env[BUDGET_PROBE_ENV] === '1';
}

/**
 * Appends one probe observation, and never lets a diagnostic break a run.
 *
 * @param rootDir - Project root whose workspace directory receives the file.
 * @param sample - Shape-only observation to persist.
 */
export function recordBudgetProbe(rootDir: string, sample: BudgetProbeSample): void {
  if (!isBudgetProbeEnabled()) return;

  try {
    const telemetryDir = agentPath(rootDir, 'telemetry');
    mkdirSync(telemetryDir, { recursive: true });
    appendFileSync(
      path.join(telemetryDir, BUDGET_PROBE_FILE),
      `${JSON.stringify({ ts: new Date().toISOString(), ...sample })}\n`,
      'utf8',
    );
  } catch {
    // A probe that can fail a turn is worse than no probe at all.
  }
}

/**
 * Reads a LangChain message discriminator without assuming its concrete class.
 *
 * Messages reach middleware either as class instances (`getType()`) or as plain
 * objects (`type`), and the budget counter already has to tolerate both.
 *
 * @param message - Unknown message from agent state.
 * @returns The discriminator, or `'unknown'` when neither form is present.
 */
export function describeMessageType(message: unknown): string {
  if (typeof message !== 'object' || message === null) return 'unknown';
  const record = message as Record<string, unknown>;
  if (typeof record.type === 'string') return record.type;
  if (typeof record.getType === 'function') {
    try {
      return String((record.getType as () => unknown)());
    } catch {
      return 'unknown';
    }
  }
  return 'unknown';
}

/**
 * Counts messages carrying a `tool_calls` array, which is the exact shape the
 * budget counter depends on.
 *
 * @param messages - Messages from agent state.
 * @returns How many are readable by the counter.
 */
export function countMessagesWithToolCallsArray(messages: readonly unknown[]): number {
  return messages.filter((message) => (
    typeof message === 'object'
    && message !== null
    && Array.isArray((message as Record<string, unknown>).tool_calls)
  )).length;
}
