import {
  ChatVertexAI,
  type ChatVertexAIInput,
} from '@langchain/google-vertexai';

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
