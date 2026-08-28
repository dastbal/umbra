import { HumanMessage } from '@langchain/core/messages';

/**
 * State keys that must not cross between an orchestrator and its delegate.
 *
 * Taken from `deepagents`' own `EXCLUDED_STATE_KEYS`
 * (`node_modules/deepagents/dist/index.js:1968`) and kept identical on purpose:
 * this bridge replaces that library's `createTaskTool` and must not quietly
 * change what a delegation shares. The library's reasons, in its own words:
 *
 * - `messages` — the delegate gets its order instead, never the conversation.
 * - `todos` and `structuredResponse` — no reducer, and no clear meaning coming
 *   back from a delegate.
 * - `skillsMetadata` and `memoryContents` — each agent loads its own; letting
 *   the parent's leak into a child was a deliberate rejection there.
 *
 * Everything else crosses in both directions. That is what makes the virtual
 * filesystem under `files` a genuine shared workspace between the orchestrator
 * and its delegates, which this project had never used.
 */
export const SUBAGENT_EXCLUDED_STATE_KEYS: readonly string[] = [
  'messages',
  'todos',
  'structuredResponse',
  'skillsMetadata',
  'memoryContents',
];

/**
 * Builds the state a delegate starts from.
 *
 * The delegate's entire view of the world is `order`: `messages` is replaced,
 * not appended to, exactly as `createTaskTool` does. Everything a delegation is
 * allowed to inherit — the shared workspace above all — is carried across
 * unchanged.
 *
 * @param parentState - The orchestrator's current graph state.
 * @param order - The rendered mandate the delegate will read.
 * @returns The delegate's initial state.
 */
export function toSubagentState(
  parentState: unknown,
  order: string,
): Record<string, unknown> {
  return {
    ...shareableKeys(parentState),
    messages: [new HumanMessage({ content: order })],
  };
}

/** What a finished delegation gives back to the orchestrator. */
export interface SubagentReturn {
  /** State to merge into the orchestrator, excluded keys removed. */
  update: Record<string, unknown>;
  /** The text the orchestrator receives as the tool result. */
  content: string;
}

/**
 * Reads a finished delegation's result.
 *
 * A structured response is the artifact and takes precedence: it is serialized
 * as the tool result so the orchestration policy can read its `status`, which is
 * how a `ready`, `blocked` or `partial` handoff is recognized. Without one, the
 * delegate's last message stands in.
 *
 * Content blocks the provider cannot accept inside a tool result — `tool_use`,
 * `thinking`, `redacted_thinking` — are dropped, mirroring `deepagents`'
 * `INVALID_TOOL_MESSAGE_BLOCK_TYPES`. Sending one back is a provider rejection,
 * which this project has already paid for once (ADR-006).
 *
 * @param result - Whatever the delegate's graph returned.
 * @returns The state update and the tool result text.
 */
export function toParentUpdate(result: unknown): SubagentReturn {
  const state = isRecord(result) ? result : {};

  return {
    update: shareableKeys(state),
    content: readContent(state),
  };
}

/** Blocks a provider rejects inside a tool result. */
const INVALID_RESULT_BLOCKS: readonly string[] = ['tool_use', 'thinking', 'redacted_thinking'];

function readContent(state: Record<string, unknown>): string {
  const structured = state['structuredResponse'];
  if (structured !== undefined && structured !== null) {
    try {
      return JSON.stringify(structured);
    } catch {
      return 'Task completed';
    }
  }

  const messages = state['messages'];
  const last = Array.isArray(messages) ? messages[messages.length - 1] : undefined;
  const content = isRecord(last) ? last['content'] : undefined;

  if (typeof content === 'string' && content.trim() !== '') return content;
  if (Array.isArray(content)) {
    const text = content
      .filter((block) => !(isRecord(block) && INVALID_RESULT_BLOCKS.includes(String(block['type']))))
      .map((block) => (isRecord(block) && typeof block['text'] === 'string'
        ? block['text']
        : safeStringify(block)))
      .join('\n')
      .trim();
    if (text !== '') return text;
  }

  return 'Task completed';
}

function shareableKeys(state: unknown): Record<string, unknown> {
  if (!isRecord(state)) return {};

  return Object.fromEntries(
    Object.entries(state).filter(([key]) => !SUBAGENT_EXCLUDED_STATE_KEYS.includes(key)),
  );
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
