/**
 * @module RequestShape
 *
 * Turns a LangChain/LangGraph request into the strings that will actually be
 * billed, so a counter can count *the request* rather than the visible half of
 * the conversation.
 *
 * ## The defect this module exists to fix
 *
 * `ContextCompressor.estimateTokens` summed `msg.content` and nothing else. What
 * it omits is not a rounding error:
 *
 * - **Tool schemas.** A deep agent publishes its whole tool catalog on every
 *   request. Those JSON schemas are thousands of fixed tokens per turn, charged
 *   before the conversation contributes anything.
 * - **The system prompt.** Also charged on every turn, also invisible.
 * - **Tool-call arguments.** An `AIMessage` that calls a tool carries its
 *   arguments in `tool_calls`, not in `content`. A turn that writes a large
 *   file therefore looks nearly free.
 *
 * The consequence is not that the number was imprecise. It is that the number
 * being compared against an 80,000-token budget was a subset of the history,
 * so the budget never described the thing it was guarding.
 */

import type { CountableTool } from './token-counter.port';

/** Text pulled out of one request, grouped by what it will be charged as. */
export interface RequestText {
  readonly system: string;
  readonly toolSchemas: readonly string[];
  readonly messages: readonly string[];
  readonly toolCallArguments: readonly string[];
  /** Number of messages, for per-message framing overhead. */
  readonly messageCount: number;
}

/**
 * Extracts plain text from a LangChain message `content` value.
 *
 * Handles the three shapes that actually occur: a string, Gemini's
 * array-of-parts, and anything else, which is serialized rather than dropped.
 * Dropping would understate the count, and understating is the direction that
 * causes an overflow rather than a wasted compression.
 *
 * @param content - The raw `message.content` value.
 * @returns Plain text.
 */
export function textOfContent(content: unknown): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    return content
      .map((part: unknown) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) {
          const text = (part as { text?: unknown }).text;
          return typeof text === 'string' ? text : '';
        }
        // A non-text part (an image, a tool-use block) still occupies the
        // request. Serializing is wrong in detail and far closer than zero.
        return JSON.stringify(part) ?? '';
      })
      .filter(Boolean)
      .join(' ');
  }

  return JSON.stringify(content) ?? '';
}

/**
 * Reads the tool-call arguments carried by an AI message.
 *
 * Both the modern `tool_calls` shape and the legacy
 * `additional_kwargs.tool_calls` are read, because a message reconstructed from
 * a checkpoint can carry either.
 *
 * @param message - One message, class instance or plain object.
 * @returns One serialized argument payload per tool call.
 */
export function toolCallArgumentsOf(message: unknown): string[] {
  if (!message || typeof message !== 'object') return [];
  const record = message as Record<string, unknown>;

  const candidates: unknown[] = [];
  if (Array.isArray(record.tool_calls)) candidates.push(...record.tool_calls);
  const legacy = (record.additional_kwargs as Record<string, unknown> | undefined)?.tool_calls;
  if (Array.isArray(legacy)) candidates.push(...legacy);

  return candidates
    .map((call) => {
      if (!call || typeof call !== 'object') return '';
      const entry = call as Record<string, unknown>;
      // `args` on the modern shape, `function.arguments` (a JSON string) on the
      // OpenAI-style one. The tool name is billed too.
      const name = typeof entry.name === 'string' ? entry.name : '';
      const args =
        entry.args !== undefined
          ? JSON.stringify(entry.args)
          : typeof (entry.function as Record<string, unknown> | undefined)?.arguments === 'string'
            ? String((entry.function as Record<string, unknown>).arguments)
            : '';
      return `${name}${args}`;
    })
    .filter(Boolean);
}

/**
 * Serializes one tool definition the way a provider receives it.
 *
 * @param tool - The tool.
 * @returns Name, description and schema as one string.
 */
export function toolDefinitionText(tool: CountableTool): string {
  const schema = tool.schema === undefined ? '' : (JSON.stringify(tool.schema) ?? '');
  return `${tool.name}${tool.description ?? ''}${schema}`;
}

/**
 * Groups everything a request will be charged for.
 *
 * @param request - The system prompt, tools and messages.
 * @returns The grouped text, ready to be counted.
 */
export function requestTextOf(request: {
  readonly system?: string;
  readonly tools?: readonly CountableTool[];
  readonly messages: readonly unknown[];
}): RequestText {
  const messages: string[] = [];
  const toolCallArguments: string[] = [];

  for (const message of request.messages ?? []) {
    const content = (message as Record<string, unknown> | null)?.content;
    const text = textOfContent(content);
    if (text) messages.push(text);
    toolCallArguments.push(...toolCallArgumentsOf(message));
  }

  return {
    system: request.system ?? '',
    toolSchemas: (request.tools ?? []).map(toolDefinitionText),
    messages,
    toolCallArguments,
    messageCount: (request.messages ?? []).length,
  };
}
