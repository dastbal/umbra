import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { LLMProvider } from '../llm/provider';

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
 * Model construction is delegated to `LLMProvider` so summarization uses the
 * same provider routing, credentials, region, and adapters as the main agent.
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
    return LLMProvider.createChatModel(modelName, temperature);
  }
}
