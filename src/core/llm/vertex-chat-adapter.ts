import {
  ChatVertexAI,
  type ChatVertexAIInput,
} from '@langchain/google-vertexai';
import type { BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import { readVisibleText } from './visible-text';

/**
 * Vertex AI chat model adapter compatible with deepagents harness profiles.
 *
 * deepagents recognizes ChatGoogleGenerativeAI as a Google provider but does
 * not currently recognize ChatVertexAI. This adapter preserves Vertex AI
 * transport and authentication while exposing the provider identity required
 * to apply the Google-specific tool exclusions.
 */
export class VertexChatAdapter extends ChatVertexAI {
  /**
   * Creates a Vertex AI chat model and normalizes Gemini tool responses.
   *
   * @param modelOrFields - Model identifier or Vertex AI model options.
   * @param params - Optional settings when a model identifier is supplied.
   */
  public constructor(
    modelOrFields?: string | ChatVertexAIInput,
    params?: Omit<ChatVertexAIInput, 'model'>,
  ) {
    const fields = typeof modelOrFields === 'string'
      ? { ...(params ?? {}), model: modelOrFields }
      : modelOrFields;
    super(fields);
    // Gemini requires the exact thought signature from a function-call turn
    // when its tool result is sent back. The current LangChain streaming path
    // loses that association while aggregating chunks. BaseChatModel therefore
    // falls back to invoke() even when a caller consumes streamEvents().
    // See ADR-006. Its consequence for what the operator reads is handled in
    // {@link VertexChatAdapter._generate}.
    this.disableStreaming = true;
    this.normalizeToolResponseRoles();
  }

  /**
   * Returns the provider identity recognized by deepagents.
   *
   * @returns The Google chat model identifier used for harness profile lookup.
   */
  public getName(): string {
    return 'ChatGoogleGenerativeAI';
  }

  /**
   * Produces the turn, and streams only the part of it the operator should read.
   *
   * ## Why this override exists
   *
   * This is the unrecorded consequence of ADR-006. `disableStreaming = true`
   * sends every Vertex turn down `@langchain/google-common`'s non-streaming
   * `_generate`, which ends with:
   *
   * ```js
   * const chunk = ret?.generations?.[0];
   * if (chunk) await runManager?.handleLLMNewToken(chunk.text || '');
   * ```
   *
   * — `chat_models.cjs:167`. It emits the generation's **flat text**, and
   * passes no structured chunk alongside it. LangChain's event tracer then has
   * nothing to rebuild from, so it synthesises the turn's single
   * `on_chat_model_stream` event with that raw string as its content.
   *
   * When Gemini returns its thinking — which it does whenever a thinking budget
   * is set, because `@langchain/google-common` derives `includeThoughts` from
   * the budget (`utils/gemini.js`:896) — that flat text is the reasoning and
   * the answer fused, with no separator. Verified live on 2026-08-28: the same
   * model call reached `on_chat_model_stream` as one string beginning "Okay, so
   * the user started with \"hola.\" My internal protocol, the CONVERSATION
   * GATE…" and ending "…Hola, soy un agente de IA", while its
   * `on_chat_model_end` carried the properly separated
   * `[{ type: 'reasoning' }, { type: 'text' }]`.
   *
   * That is why filtering in the CLI was not enough. {@link readVisibleText}
   * can separate blocks; it cannot un-fuse a string. So the split is done here,
   * on the structured message, before the fusion can happen: the library's own
   * token emission is silenced for this call, and the visible half is emitted
   * in its place through the same callback.
   *
   * The returned {@link ChatResult} is left **untouched**. The reasoning stays
   * in the message, so `on_chat_model_end`, the checkpointer, the trace and the
   * token accounting all see exactly what the provider returned. Only what is
   * *rendered as it arrives* changes.
   *
   * ### Why not simply stop asking for thoughts
   *
   * Forcing `includeThoughts: false` would also work, and would cost less. It
   * is not done here because that flag rides in the same `thinkingConfig` as
   * the thought signatures whose loss ADR-006 exists to prevent, and this
   * repository has already spent two days on that failure. Suppressing the
   * *display* cannot break a tool cycle; suppressing the *request* might.
   *
   * @param messages - The conversation sent to the model.
   * @param options - Parsed call options for this invocation.
   * @param runManager - Callback manager for the run, when one is active.
   * @returns The provider's complete result, unmodified.
   */
  public async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    if (!runManager) {
      return super._generate(messages, options, runManager);
    }

    const result = await super._generate(
      messages,
      options,
      VertexChatAdapter.withoutTokenEmission(runManager),
    );

    const visible = readVisibleText(result.generations?.[0]?.message?.content);
    if (visible) await runManager.handleLLMNewToken(visible);

    return result;
  }

  /**
   * Copies a run manager with only its token emission disabled.
   *
   * Prototype delegation rather than a rewritten object: every other callback
   * — the custom request/response events the Vertex connection raises, the
   * error path, the run identity — keeps reaching the real manager untouched.
   * Silencing the whole manager instead would have traded a rendering defect
   * for an observability one.
   *
   * @param runManager - The live callback manager for this run.
   * @returns A delegate whose `handleLLMNewToken` does nothing.
   */
  private static withoutTokenEmission(
    runManager: CallbackManagerForLLMRun,
  ): CallbackManagerForLLMRun {
    const silenced = Object.create(runManager) as CallbackManagerForLLMRun;
    silenced.handleLLMNewToken = async (): Promise<void> => undefined;
    return silenced;
  }

  /**
   * Rewrites function-response message roles for Gemini 3.5 Vertex requests.
   *
   * The installed LangChain Google adapter emits function responses with the
   * legacy function role. Gemini 3.5 requires user for function responses.
   *
   * @returns Nothing.
   */
  private normalizeToolResponseRoles(): void {
    for (const connection of [this.connection, this.streamedConnection]) {
      const buildGeminiAPI = connection.buildGeminiAPI.bind(connection);

      connection.buildGeminiAPI = () => {
        const api = buildGeminiAPI();
        const baseMessageToContent = api.baseMessageToContent;

        if (!baseMessageToContent) return api;

        api.baseMessageToContent = async (...args) => {
          const contents = await baseMessageToContent(...args);

          return contents.map((content) => ({
            ...content,
            role: content.role === 'function' &&
              content.parts.some((part) => 'functionResponse' in part)
              ? 'user'
              : content.role,
          }));
        };

        return api;
      };
    }
  }
}
