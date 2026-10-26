/**
 * @module ContextCompressor
 *
 * On-demand context compression for `/model` switches in the CLI.
 *
 * ## Why this exists
 * When a user switches models via `/model`, the new agent starts with a blank
 * slate and has no knowledge of the previous conversation. `ContextCompressor`
 * reads the current LangGraph state, distills the history into a compact summary,
 * and returns it so `ChatSession` can inject it as the first message in the new
 * agent's context.
 *
 * ## Why NOT deepagents' SummarizationMiddleware
 * deepagents already installs its own summarization middleware on every deep
 * agent, at 85% of the model's window, and it stays there as the backstop. A
 * `/model` switch needs something different: a summary taken *out* of one agent
 * and handed to a new one, which no middleware inside either agent can do.
 * `ContextCompressor` is a one-shot LLM call via `LLMProvider.createChatModel()`
 * with no contact with deepagents internals.
 *
 * This section used to cite ADR-007 and `REQUIRED_MIDDLEWARE_NAMES` as the
 * reason. ADR-007 never mentions summarization, and that set was
 * `{FilesystemMiddleware, SubAgentMiddleware}`; the conclusion held, the reason
 * did not.
 *
 * ## What it no longer does
 * It also compressed proactively after every turn, through `isOverBudget` and
 * `estimateTokens`, and `ChatSession` sent the summary back into the same
 * thread — two model calls that removed nothing. Stale tool results are now
 * cleared inside the model call by `createContextEditingMiddleware` (ADR-037),
 * and both methods were removed with the path that called them.
 *
 * ## Fallback chain (ADR-020)
 * 1. **Primary**: `CONTEXT_SUMMARIZER_MODEL` env var (default: `gemini-2.5-flash-lite`)
 * 2. **Fallback**: `ollama:gemma4` — local, no network required
 * 3. **Final**: `null` — the model switch still completes, but without context handoff
 *
 * @example
 * ```ts
 * const summary = await ContextCompressor.compress(messages, 'gemini-2.5-flash-lite');
 * if (summary) {
 *   await session.sendMessage(`[CONTEXT HANDOFF]\n\n${summary}`);
 * }
 * ```
 */

import { HumanMessage, AIMessage } from '@langchain/core/messages';
import { LLMProvider } from '../llm/provider';
import { isOllamaModel } from '../config/model-resolver';

// ── Constants ──────────────────────────────────────────────────────────────────

/**
 * System prompt used for the one-shot compression call.
 *
 * Instructs the LLM to produce a tight, technical summary focused on
 * decisions, files, and work state — not conversational filler.
 */
const COMPRESSION_SYSTEM_PROMPT = `You are summarizing a conversation between a developer and an AI coding assistant.

Produce a concise technical summary (max 500 words) covering:
1. Key architectural or implementation decisions made, and why
2. Files created or modified (include exact file paths)
3. Tasks completed and their current status
4. Any critical bugs found and whether they were fixed
5. Current work state — what is in progress or pending

Rules:
- Focus on technical facts. Omit greetings, filler, and repetition.
- Use bullet points, not paragraphs.
- Output only the summary — no preamble, no "Here is a summary:" opener.`;

/**
 * Ollama model used as fallback when the primary cloud model is unavailable.
 * Must be installed locally: `ollama pull gemma4`
 */
const OLLAMA_FALLBACK_MODEL = 'ollama:gemma4';

/**
 * Minimum number of messages required to attempt compression.
 * Below this threshold the history is too short to be worth compressing.
 */
const MIN_MESSAGES_FOR_COMPRESSION = 3;

// ── Class ─────────────────────────────────────────────────────────────────────

/**
 * Compresses LangGraph conversation history for context handoff during model switches.
 *
 * All methods are static — this class is a pure utility with no instance state.
 */
export class ContextCompressor {
  private constructor() {}

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Compresses a LangGraph conversation history into a concise summary string.
   *
   * Filters to `HumanMessage` + `AIMessage` only — `ToolMessage` raw outputs are
   * excluded because they are large, noisy, and not useful for context handoff.
   *
   * Applies a fallback chain (ADR-020):
   * 1. Try `summarizerModel` (primary)
   * 2. If primary fails and is not already Ollama → try `ollama:gemma4` (local fallback)
   * 3. If all fail → return `null` (graceful degradation; model switch still completes)
   *
   * @param messages - Raw messages from `agent.getState().values.messages`
   * @param summarizerModel - The model string to use for compression
   * @returns The compressed summary string, or `null` if compression failed entirely
   */
  public static async compress(
    messages: unknown[],
    summarizerModel: string,
  ): Promise<string | null> {
    if (!messages || messages.length < MIN_MESSAGES_FOR_COMPRESSION) {
      return null;
    }

    const dialogue = ContextCompressor.buildDialogue(messages);
    if (!dialogue.trim()) return null;

    // 1. Try primary model
    try {
      return await ContextCompressor.callLLM(summarizerModel, dialogue);
    } catch (primaryErr: unknown) {
      const msg = (primaryErr as Error)?.message ?? String(primaryErr);
      console.warn(`  [ContextCompressor] Primary model (${summarizerModel}) failed: ${msg}`);
    }

    // 2. Fallback to local Ollama (only if primary was a cloud model)
    if (!isOllamaModel(summarizerModel)) {
      try {
        console.warn(`  [ContextCompressor] Attempting fallback with ${OLLAMA_FALLBACK_MODEL}...`);
        return await ContextCompressor.callLLM(OLLAMA_FALLBACK_MODEL, dialogue);
      } catch (fallbackErr: unknown) {
        const msg = (fallbackErr as Error)?.message ?? String(fallbackErr);
        console.warn(`  [ContextCompressor] Fallback model also failed: ${msg}`);
      }
    }

    // 3. Total failure — return null so the model switch can still proceed
    return null;
  }

  // ── Private Helpers ─────────────────────────────────────────────────────────

  /**
   * Builds a readable dialogue string from a LangGraph messages array.
   *
   * Only `HumanMessage` and `AIMessage` are included:
   * - `HumanMessage` → `"Human: <content>"`
   * - `AIMessage`    → `"Assistant: <content>"` (skipped if content is empty)
   * - `ToolMessage`  → **excluded** (raw tool outputs are large and noisy)
   *
   * Handles both string content and array-of-parts content (Gemini format).
   *
   * @param messages - Raw messages array from agent state
   * @returns Newline-separated dialogue string ready for LLM consumption
   */
  private static buildDialogue(messages: unknown[]): string {
    const lines: string[] = [];

    for (const msg of messages) {
      if (msg instanceof HumanMessage) {
        const content = ContextCompressor.extractText(msg.content);
        if (content) lines.push(`Human: ${content}`);
      } else if (msg instanceof AIMessage) {
        const content = ContextCompressor.extractText(msg.content);
        if (content) lines.push(`Assistant: ${content}`);
      }
      // ToolMessage intentionally excluded — raw outputs are large and noisy
    }

    return lines.join('\n\n');
  }

  /**
   * Extracts a plain text string from a LangChain message content value.
   *
   * Handles three formats:
   * - `string` — returned as-is
   * - `Array<{ type: 'text'; text: string } | unknown>` — Gemini array-of-parts
   * - Other — serialized to JSON as a fallback
   *
   * @param content - The raw `message.content` value
   * @returns A plain text string
   */
  private static extractText(content: unknown): string {
    if (typeof content === 'string') return content;

    if (Array.isArray(content)) {
      return content
        .map((part: unknown) => {
          if (typeof part === 'string') return part;
          if (part && typeof part === 'object' && 'text' in part) {
            return (part as { text: string }).text ?? '';
          }
          return '';
        })
        .filter(Boolean)
        .join(' ');
    }

    return JSON.stringify(content);
  }

  /**
   * Calls the specified LLM in one-shot mode to generate a compression summary.
   *
   * Uses `LLMProvider.createChatModel()` which already handles Vertex AI and Ollama
   * routing, credential validation, and the `OllamaChatAdapter` serialization fix.
   *
   * @param model - Model string (e.g., `'gemini-2.5-flash-lite'`, `'ollama:gemma4'`)
   * @param dialogue - The formatted conversation text to summarize
   * @returns The summary string from the LLM
   * @throws {Error} If the LLM call fails or returns an unexpected format
   */
  private static async callLLM(model: string, dialogue: string): Promise<string> {
    const llm = LLMProvider.createChatModel(model, 0);

    const response = await llm.invoke([
      { role: 'system', content: COMPRESSION_SYSTEM_PROMPT },
      { role: 'user', content: `Conversation to summarize:\n\n${dialogue}` },
    ]);

    // Normalize the response content (string or array-of-parts)
    return ContextCompressor.extractText(response.content);
  }
}
