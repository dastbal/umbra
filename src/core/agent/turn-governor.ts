/**
 * Dimensions a single interactive turn can be bounded by.
 *
 * Recorded telemetry is the reason there is more than one. Across 120 turns in
 * `.umbra/telemetry/interactive-turns.jsonl`, tool execution accounted for
 * 62.9s of 4,532s elapsed — 1.4%. A counter of tool calls therefore bounds the
 * cheap part of a turn and leaves the expensive part unbounded, which is how a
 * turn reached 921 seconds and how the word "hey" reached 108.
 */
export type TurnDimension = 'tool-calls' | 'tokens' | 'seconds' | 'cost';

/** Ceilings applied to one interactive turn. */
export interface TurnLimits {
  /**
   * Tool-call attempts. Kept at the value the project already declared; the
   * change is that it is now enforced rather than merely recorded.
   */
  maxToolCalls: number;
  /** Prompt plus completion tokens observed for the turn. */
  maxTokens: number;
  /**
   * Wall-clock seconds. 300 sits above the 95th percentile of recorded turns
   * (237.8s) and below the 921s outlier that motivated this bound.
   */
  maxSeconds: number;
  /** Optional USD ceiling. Requires a pricing function; unset means unenforced. */
  maxCostUsd?: number;
}

/** Mutable spend accumulated during one turn. */
export interface TurnSpend {
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  /**
   * The share of `outputTokens` the model spent thinking rather than answering.
   *
   * A **subset**, never an addition: providers that report it already counted
   * it inside `outputTokens`, so adding it anywhere would double-count the
   * turn. It is tracked separately only to answer one question — how much of
   * this turn was paid for deliberation the operator never sees, since
   * [ADR-006](../../../docs/adr/ADR-006-vertex-tool-cycle-streaming-fallback.md)
   * stopped printing it.
   *
   * Stays 0 when the provider reports nothing, which is not the same as a turn
   * that genuinely did not think. `@langchain/anthropic` reports no breakdown
   * at all in the installed version; Gemini reports `thoughtsTokenCount`.
   */
  reasoningTokens: number;
  startedAtMs: number;
}

/** Token counts read from a provider response. */
export interface ObservedUsage {
  inputTokens: number;
  outputTokens: number;
  /** Thinking tokens, already included in `outputTokens`. Absent when unreported. */
  reasoningTokens?: number;
}

/** Converts observed usage into USD, when pricing for the model is known. */
export type CostResolver = (usage: ObservedUsage) => number | undefined;

/**
 * Default ceilings for an interactive Deep-agent turn.
 *
 * `maxToolCalls` matches `DEFAULT_INTERACTIVE_TOOL_BUDGET`. The other two are
 * derived from the recorded distribution rather than chosen: 98 of 120 turns
 * used three tool calls or fewer, and the median turn took 4.1 seconds.
 */
export const DEFAULT_TURN_LIMITS: Readonly<TurnLimits> = {
  maxToolCalls: 8,
  maxTokens: 250_000,
  maxSeconds: 300,
};

/**
 * Starts a fresh spend record for one turn.
 *
 * @param nowMs - Turn start timestamp, injected so the caller owns the clock.
 * @returns A zeroed spend record.
 */
export function createTurnSpend(nowMs: number): TurnSpend {
  return {
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    startedAtMs: nowMs,
  };
}

/**
 * Records one executed tool call.
 *
 * The governor counts what it does itself rather than counting `tool_calls`
 * entries in agent state. Reading state means trusting a message shape this
 * code did not create; telemetry shows turns exceeding the state-derived budget
 * by more than any single batch can explain, so the self-observed count is the
 * one that cannot be wrong about its own units.
 *
 * @param spend - Spend record for the current turn.
 */
export function recordToolCall(spend: TurnSpend): void {
  spend.toolCalls += 1;
}

/**
 * Adds observed provider usage to the turn.
 *
 * @param spend - Spend record for the current turn.
 * @param usage - Token counts from one model response.
 */
export function recordUsage(spend: TurnSpend, usage: ObservedUsage): void {
  spend.inputTokens += usage.inputTokens;
  spend.outputTokens += usage.outputTokens;
  // Accumulated, never added to the totals: it is already inside outputTokens.
  spend.reasoningTokens += usage.reasoningTokens ?? 0;
}

/**
 * Reads token usage from a provider response without assuming a message class.
 *
 * Returns `null` when the provider reported nothing. A turn whose usage is
 * unreported is bounded by time and tool calls only; that degradation is
 * deliberate, because inventing a token count would bound nothing while
 * appearing to.
 *
 * @param message - The value returned by the model call.
 * @returns Observed usage, or `null` when the provider supplied none.
 */
export function readUsage(message: unknown): ObservedUsage | null {
  if (typeof message !== 'object' || message === null) return null;
  const usage = (message as Record<string, unknown>).usage_metadata;
  if (typeof usage !== 'object' || usage === null) return null;

  const record = usage as Record<string, unknown>;
  const inputTokens = typeof record.input_tokens === 'number' ? record.input_tokens : 0;
  const outputTokens = typeof record.output_tokens === 'number' ? record.output_tokens : 0;
  if (inputTokens === 0 && outputTokens === 0) return null;

  return { inputTokens, outputTokens, ...readReasoningTokens(record) };
}

/**
 * Reads the thinking share of a response's completion tokens.
 *
 * LangChain normalizes this to `output_token_details.reasoning`; for Gemini it
 * is `thoughtsTokenCount` (`@langchain/google-common/utils/gemini.js`:587).
 * Providers that report no breakdown yield nothing rather than a zero, so an
 * unreported turn is never mistaken for a turn that did not think.
 *
 * @param usage - The response's `usage_metadata`, already narrowed to a record.
 * @returns `{ reasoningTokens }` when reported, an empty object otherwise.
 */
function readReasoningTokens(usage: Record<string, unknown>): { reasoningTokens?: number } {
  const details = usage.output_token_details;
  if (typeof details !== 'object' || details === null) return {};

  const reasoning = (details as Record<string, unknown>).reasoning;
  return typeof reasoning === 'number' ? { reasoningTokens: reasoning } : {};
}

/**
 * Reports the first ceiling this turn has reached, if any.
 *
 * @param spend - Spend record for the current turn.
 * @param limits - Ceilings in force.
 * @param nowMs - Current timestamp.
 * @param costOf - Optional pricing function enabling the cost dimension.
 * @returns The exceeded dimension, or `null` while the turn is within budget.
 */
export function exceededDimension(
  spend: TurnSpend,
  limits: TurnLimits,
  nowMs: number,
  costOf?: CostResolver,
): TurnDimension | null {
  if (spend.toolCalls >= limits.maxToolCalls) return 'tool-calls';
  if (spend.inputTokens + spend.outputTokens >= limits.maxTokens) return 'tokens';
  if ((nowMs - spend.startedAtMs) / 1000 >= limits.maxSeconds) return 'seconds';

  if (limits.maxCostUsd !== undefined && costOf) {
    const spent = costOf({
      inputTokens: spend.inputTokens,
      outputTokens: spend.outputTokens,
    });
    if (spent !== undefined && spent >= limits.maxCostUsd) return 'cost';
  }

  return null;
}

/**
 * Builds the instruction handed to the model when a ceiling is reached.
 *
 * It states which ceiling stopped the turn, because a model told only to stop
 * tends to apologise; one told what ran out reports what it has.
 *
 * @param dimension - The ceiling that was reached.
 * @param spend - Spend record for the current turn.
 * @param limits - Ceilings in force.
 * @param nowMs - Current timestamp.
 * @returns A prompt fragment appended to the system prompt for the final call.
 */
export function describeStop(
  dimension: TurnDimension,
  spend: TurnSpend,
  limits: TurnLimits,
  nowMs: number,
): string {
  const reason: Record<TurnDimension, string> = {
    'tool-calls': `you have used ${spend.toolCalls} of ${limits.maxToolCalls} tool calls`,
    tokens: `this turn has spent ${spend.inputTokens + spend.outputTokens} of ${limits.maxTokens} tokens`,
    seconds: `this turn has run for ${Math.round((nowMs - spend.startedAtMs) / 1000)}s of ${limits.maxSeconds}s`,
    cost: `this turn has reached its cost ceiling of ${limits.maxCostUsd} USD`,
  };

  return `TURN BUDGET REACHED — ${reason[dimension]}. Do not request tools. Answer now with the evidence already collected, cite the concrete files you read, and state plainly what you could not verify.`;
}
