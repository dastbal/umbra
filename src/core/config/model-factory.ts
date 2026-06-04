import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatVertexAI } from '@langchain/google-vertexai';
import { isGeminiModel } from './model-resolver';

/**
 * @module ModelFactory
 *
 * Instantiates a concrete `BaseChatModel` from a model identifier string.
 *
 * This factory bridges the gap between the model-resolver (which works with
 * strings) and APIs that require a real `BaseChatModel` instance — specifically
 * `createSummarizationMiddleware` from deepagents, which needs an actual LLM
 * object to call when summarizing long conversation histories.
 *
 * **Currently supported providers:**
 * - Gemini / Vertex AI (`gemini-*` prefix) — uses `GOOGLE_APPLICATION_CREDENTIALS`
 *
 * Additional providers (Ollama, Anthropic, Google GenAI) can be added later
 * by installing the corresponding `@langchain/*` package and extending `create()`.
 *
 * @example
 * ```ts
 * const llm = ModelFactory.create('gemini-2.5-flash-lite');
 * const middleware = createSummarizationMiddleware({ model: llm, backend: ... });
 * ```
 */
export class ModelFactory {
  /**
   * Create a `BaseChatModel` instance from a model identifier string.
   *
   * For the summarization use case, `temperature=0` is recommended so that
   * generated summaries are deterministic and stable across runs.
   *
   * @param modelName - The resolved model string (e.g., `"gemini-2.5-flash-lite"`).
   * @param temperature - Sampling temperature. @default 0
   * @returns A `BaseChatModel` ready to be passed to deepagents middleware.
   * @throws Error if the provider is not yet supported.
   */
  public static create(modelName: string, temperature = 0): BaseChatModel {
    if (isGeminiModel(modelName)) {
      // Vertex AI is our primary Gemini provider (enterprise, uses service account auth).
      // No API key needed — relies on GOOGLE_APPLICATION_CREDENTIALS env var.
      return new ChatVertexAI({
        model: modelName,
        temperature,
      }) as unknown as BaseChatModel;
    }

    // For model strings deepagents itself understands (e.g., Ollama, Anthropic),
    // we return a lightweight proxy so the middleware can still call it.
    // deepagents will resolve the actual model at runtime via its own harness.
    throw new Error(
      `ModelFactory: Provider not yet configured for model "${modelName}". ` +
      `Currently supports Gemini/Vertex AI models (gemini-* prefix). ` +
      `To add support, install the provider's @langchain/* package and extend ModelFactory.create().`,
    );
  }
}
