import { ToolMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import {
  countMessagesWithToolCallsArray,
  describeMessageType,
  recordBudgetProbe,
} from './budget-probe';
import {
  DEFAULT_TURN_LIMITS,
  type CostResolver,
  type TurnDimension,
  type TurnLimits,
  type TurnSpend,
  createTurnSpend,
  describeStop,
  exceededDimension,
  readUsage,
  recordToolCall,
  recordUsage,
} from './turn-governor';

/** Maximum tool-call attempts allowed for one interactive Deep-agent turn. */
export const DEFAULT_INTERACTIVE_TOOL_BUDGET = 8;

/** Optional wiring for the turn governor. */
export interface TurnGovernorOptions {
  /** Ceiling overrides; anything omitted falls back to {@link DEFAULT_TURN_LIMITS}. */
  limits?: Partial<TurnLimits>;
  /** Enables the cost dimension by pricing observed usage. */
  costOf?: CostResolver;
  /** Notified after every tool call and model response, for live reporting. */
  onSpend?: (spend: Readonly<TurnSpend>, stopped: TurnDimension | null) => void;
  /** Clock injection point; production uses `Date.now`. */
  now?: () => number;
}

/**
 * Creates the middleware that bounds one interactive turn.
 *
 * Three things changed from the tool-call-only budget this replaces, each
 * because recorded telemetry showed the previous shape did not hold:
 *
 * 1. **The ceiling is enforced after a tool call, not only before a model
 *    call.** The old check ran in `wrapModelCall`, so a model that requested
 *    six tools in one response spent all six: the budget was a floor, not a
 *    ceiling, and 13 of 120 recorded turns exceeded it, one by 2.25x.
 * 2. **The count is self-observed.** Counting `tool_calls` entries in agent
 *    state means trusting a message shape this code did not create. The
 *    governor counts the calls it actually wraps.
 * 3. **Tool calls are no longer the only dimension.** Tool execution was 1.4%
 *    of recorded elapsed time, so a turn can be cheap by that measure and still
 *    run 921 seconds. Tokens and wall-clock are bounded too, and `maxCostUsd`
 *    — declared in `agent.config.json` and until now enforced nowhere — becomes
 *    real when a pricing function is supplied.
 *
 * The per-turn state is held in the closure, which assumes one turn at a time
 * per agent instance. That holds for the interactive CLI, which awaits each
 * turn; it would not hold for concurrent invocations of the same agent object.
 *
 * @param maxToolCalls - Maximum tool-call attempts permitted in one user turn.
 * @param rootDir - Project root used only by the off-by-default budget probe.
 * @param options - Ceilings, pricing and reporting for the turn governor.
 * @returns Middleware suitable for `createDeepAgent`.
 */
export function createIterationBudgetMiddleware(
  maxToolCalls = DEFAULT_INTERACTIVE_TOOL_BUDGET,
  rootDir: string = process.cwd(),
  options: TurnGovernorOptions = {},
) {
  const now = options.now ?? (() => Date.now());
  const limits: TurnLimits = { ...DEFAULT_TURN_LIMITS, maxToolCalls, ...options.limits };
  let spend = createTurnSpend(now());

  const report = (stopped: TurnDimension | null): void => options.onSpend?.(spend, stopped);
  const overBudget = (): TurnDimension | null =>
    exceededDimension(spend, limits, now(), options.costOf);

  return createMiddleware({
    name: 'InteractiveIterationBudget',

    // One user turn per agent invocation, so this is the only correct place to
    // reset. A turn that inherited the previous turn's spend would refuse work
    // it never did.
    beforeAgent: async () => {
      spend = createTurnSpend(now());
      report(null);
      return undefined;
    },
    wrapToolCall: async (request, handler) => {
      // Enforced here, not only before the model call. A model that asks for
      // six tools in one response would otherwise spend all six past the
      // ceiling; this refuses the ones past it without ever touching the disk.
      const stopped = overBudget();
      if (stopped !== null && request.toolCall.id !== undefined) {
        report(stopped);
        return new ToolMessage({
          tool_call_id: request.toolCall.id,
          content: describeStop(stopped, spend, limits, now()),
        });
      }

      if (
        request.toolCall.id === undefined ||
        !hasPriorEquivalentToolCall(request.state.messages, request.toolCall)
      ) {
        recordToolCall(spend);
        report(overBudget());
        return handler(request);
      }

      // A repeat is answered from the turn's own history, so it is not charged:
      // refusing it and then counting it would punish the model twice.
      return new ToolMessage({
        tool_call_id: request.toolCall.id,
        content: 'This exact tool call was already completed in this turn. Use the existing evidence and provide the final answer without repeating it.',
      });
    },
    wrapModelCall: async (request, handler) => {
      const messages = request.state.messages;
      // The counter assumes deepagents hands it messages carrying a `tool_calls`
      // array. That assumption has never been verified against a live run, and
      // telemetry shows turns exceeding this budget by more than one batch can
      // explain — so record the shape before trusting the count.
      recordBudgetProbe(rootDir, {
        at: 'wrapModelCall',
        messageCount: messages.length,
        messageTypes: messages.map(describeMessageType),
        messagesWithToolCallsArray: countMessagesWithToolCallsArray(messages),
        countedToolCalls: countCurrentTurnToolCalls(messages),
        wouldForceFinal: shouldForceFinalResponse(messages, maxToolCalls),
      });

      // The self-observed governor decides. `shouldForceFinalResponse` reads the
      // very state the probe is questioning, so it is kept only as a second
      // guard: where the shape is readable it catches an overshoot one step
      // earlier, and where it is not it silently contributes nothing.
      const stopped = overBudget() ?? (
        shouldForceFinalResponse(messages, maxToolCalls) ? 'tool-calls' : null
      );

      const response = stopped === null
        ? await handler(request)
        : await handler({
          ...request,
          tools: [],
          systemPrompt: [
            request.systemPrompt ?? '',
            describeStop(stopped, spend, limits, now()),
          ].join('\n\n'),
        });

      // Usage is only observable on the response, which is why the token and
      // cost dimensions live here rather than in the CLI: the deep path never
      // read `usage_metadata` at all.
      const usage = readUsage(response);
      if (usage) recordUsage(spend, usage);
      report(overBudget());
      return response;
    },
  });
}

/** Counts planned tool calls after the latest human message in persisted state. */
export function countCurrentTurnToolCalls(messages: readonly unknown[]): number {
  return messages
    .slice(findCurrentTurnStart(messages))
    .reduce<number>((count, message) => count + readToolCalls(message).length, 0);
}

/** Returns whether a persisted turn has consumed its allowed tool attempts. */
export function shouldForceFinalResponse(
  messages: readonly unknown[],
  maxToolCalls = DEFAULT_INTERACTIVE_TOOL_BUDGET,
): boolean {
  return countCurrentTurnToolCalls(messages) >= maxToolCalls;
}

/** Checks whether the current tool was already requested with equivalent arguments. */
export function hasPriorEquivalentToolCall(
  messages: readonly unknown[],
  currentToolCall: { id?: string; name: string; args: unknown },
): boolean {
  const currentFingerprint = toolFingerprint(currentToolCall.name, currentToolCall.args);
  return messages
    .slice(findCurrentTurnStart(messages))
    .flatMap(readToolCalls)
    .some((toolCall) => toolCall.id !== currentToolCall.id && toolFingerprint(toolCall.name, toolCall.args) === currentFingerprint);
}

function findCurrentTurnStart(messages: readonly unknown[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isHumanMessage(messages[index])) return index;
  }
  return 0;
}

interface ToolCallRecord {
  id?: string;
  name: string;
  args: unknown;
}

function readToolCalls(message: unknown): ToolCallRecord[] {
  if (!isRecord(message) || !Array.isArray(message.tool_calls)) return [];
  return message.tool_calls.flatMap((toolCall) => {
    if (!isRecord(toolCall) || typeof toolCall.name !== 'string') return [];
    return [{
      id: typeof toolCall.id === 'string' ? toolCall.id : undefined,
      name: toolCall.name,
      args: toolCall.args,
    }];
  });
}

function isHumanMessage(message: unknown): boolean {
  if (!isRecord(message)) return false;
  if (message.type === 'human') return true;
  return typeof message.getType === 'function' && message.getType() === 'human';
}

function toolFingerprint(toolName: string, args: unknown): string {
  return `${toolName}:${stableSerialize(args)}`;
}

/** Produces deterministic in-memory fingerprints without retaining raw values. */
function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (!isRecord(value)) return JSON.stringify(value);

  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
    .join(',')}}`;
}

/** Narrows message instances and plain tool arguments before property access. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
