/**
 * @module OllamaChatAdapter
 *
 * A transparent wrapper around `ChatOllama` that normalizes tool-call message
 * content before forwarding them to the Ollama API.
 *
 * ## Problem
 * Ollama's OpenAI-compatible API requires all message `content` fields to be
 * strings. When `deepagents` (or any LangChain tool) returns a ToolMessage
 * whose `.content` is an object or array, `ChatOllama` throws:
 *
 *   > Non string tool message content is not supported
 *
 * ## Solution
 * `OllamaChatAdapter` intercepts the `messages` array in `_generate()` and
 * `stream()`, finds any `ToolMessage` whose content is not a string, and
 * JSON-serializes it. The rest of the call is delegated to the parent class.
 *
 * This is fully transparent — callers see a normal `ChatOllama` instance.
 * `deepagents` receives a `BaseChatModel` and uses it directly without string
 * routing through `initChatModel`, so no secondary resolution occurs.
 *
 * @example
 * ```ts
 * const model = new OllamaChatAdapter({
 *   model: 'gemma4:e2b',
 *   baseUrl: 'http://localhost:11434',
 *   temperature: 0,
 * });
 * createDeepAgent({ model }); // passes BaseChatModel directly
 * ```
 */

import { ChatOllama } from '@langchain/ollama';
import { BaseMessage, ToolMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';

/**
 * Transparent `ChatOllama` wrapper that serializes non-string tool message
 * content before sending to the Ollama API.
 *
 * Ollama's API layer rejects tool message content that is not a plain string.
 * Tools in deepagents (e.g., built-in `read_file`) may return objects. This
 * adapter stringifies any such content transparently so Ollama can process it.
 *
 * All other behavior (streaming, tool binding, temperature, etc.) is inherited
 * from `ChatOllama` without modification.
 */
export class OllamaChatAdapter extends ChatOllama {
  /**
   * Normalize a messages array so all ToolMessage content values are strings.
   *
   * - If content is already a string, it is left unchanged.
   * - If content is an array of content blocks (LangChain's multi-part format),
   *   we extract all `text` parts and join them, or fall back to JSON.stringify.
   * - Otherwise, JSON.stringify is used.
   *
   * @param messages - The full message array from the agent loop.
   * @returns A new array with ToolMessage contents coerced to strings.
   */
  private normalizeToolMessages(messages: BaseMessage[]): BaseMessage[] {
    return messages.map((msg) => {
      if (!(msg instanceof ToolMessage)) return msg;
      const content = msg.content;

      if (typeof content === 'string') return msg;

      let serialized: string;
      if (Array.isArray(content)) {
        // LangChain multi-part blocks: [{type:'text', text:'...'}, ...]
        const textParts = content
          .filter((block) => typeof block === 'object' && block !== null && 'text' in block)
          .map((block) => (block as { text: string }).text);
        serialized = textParts.length > 0 ? textParts.join('\n') : JSON.stringify(content);
      } else {
        serialized = JSON.stringify(content);
      }

      // Reconstruct a ToolMessage with the serialized string content.
      return new ToolMessage({
        content: serialized,
        tool_call_id: msg.tool_call_id,
        name: msg.name,
        additional_kwargs: msg.additional_kwargs,
      });
    });
  }

  /**
   * Override `_generate` to normalize tool message content before the API call.
   *
   * @param messages - Raw message array from the agent loop.
   * @param options - LangChain call options (tools, stop sequences, etc.).
   * @param runManager - Optional LangChain callback manager.
   * @returns The model's `ChatResult`.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override async _generate(messages: BaseMessage[], options: any, runManager?: any): Promise<ChatResult> {
    return super._generate(this.normalizeToolMessages(messages), options, runManager);
  }

  /**
   * Override `stream` to normalize tool message content before the API call.
   *
   * @param messages - Raw message array from the agent loop.
   * @param options - LangChain call options.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override stream(messages: BaseMessage[], options?: any): any {
    return super.stream(this.normalizeToolMessages(messages), options);
  }
}
