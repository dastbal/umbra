import { ToolMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';

/** Maximum tool-call attempts allowed for one interactive Deep-agent turn. */
export const DEFAULT_INTERACTIVE_TOOL_BUDGET = 8;

/**
 * Creates a LangChain middleware that removes tools after the interactive
 * budget is spent. The model still receives all completed tool results and is
 * explicitly instructed to synthesize them into a final response.
 *
 * @param maxToolCalls - Maximum tool-call attempts permitted in one user turn.
 * @returns Middleware suitable for `createDeepAgent`.
 */
export function createIterationBudgetMiddleware(
  maxToolCalls = DEFAULT_INTERACTIVE_TOOL_BUDGET,
) {
  return createMiddleware({
    name: 'InteractiveIterationBudget',
    wrapToolCall: async (request, handler) => {
      if (
        request.toolCall.id === undefined ||
        !hasPriorEquivalentToolCall(request.state.messages, request.toolCall)
      ) {
        return handler(request);
      }

      return new ToolMessage({
        tool_call_id: request.toolCall.id,
        content: 'This exact tool call was already completed in this turn. Use the existing evidence and provide the final answer without repeating it.',
      });
    },
    wrapModelCall: async (request, handler) => {
      if (!shouldForceFinalResponse(request.state.messages, maxToolCalls)) return handler(request);

      return handler({
        ...request,
        tools: [],
        systemPrompt: `${request.systemPrompt ?? ''}\n\nITERATION BUDGET EXHAUSTED: You have enough collected evidence. Do not request tools. Give the user a concise final answer now; cite the concrete files already read and state any remaining uncertainty.`,
      });
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
