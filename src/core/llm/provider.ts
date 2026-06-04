/**
 * @module LLMProvider
 *
 * Multi-provider LLM factory for nestjs-ai-agent-lib.
 *
 * ## Provider Routing
 * The provider is inferred from the model string:
 * - `"gemini-*"`, `"google:*"`, `"google-vertexai:*"` → Vertex AI (`ChatVertexAI`)
 * - `"ollama:*"` → Local Ollama (`OllamaChatAdapter` — a `ChatOllama` wrapper
 *   that serializes non-string tool message content before sending to Ollama API)
 *
 * ## Embeddings
 * Embeddings are **always** Vertex AI (`VertexAIEmbeddings` with `text-embedding-004`),
 * regardless of which chat model is active. Rationale: Ollama embedding models are
 * significantly lower quality than Google's, and the RAG index would need a full
 * re-index every time you switch models. Using a stable cloud embedding model
 * keeps the index consistent and fast.
 *
 * @example
 * ```ts
 * // Auto-routes based on AGENT_MODEL env var
 * const chat = LLMProvider.createChatModel('gemini-2.5-flash-lite');
 * const chat = LLMProvider.createChatModel('ollama:gemma4');
 *
 * // Embeddings are always Vertex AI
 * const embeddings = LLMProvider.getEmbeddingsModel();
 * ```
 */

import { ChatVertexAI, VertexAIEmbeddings } from '@langchain/google-vertexai';
import { OllamaChatAdapter } from './ollama-adapter';
import { isOllamaModel, isGeminiModel } from '../config/model-resolver';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

// Load env vars from the project root on module import.
// process.cwd() resolves to the directory where "npm run agent" is executed.
const rootDir = process.cwd();
dotenv.config({ path: path.join(rootDir, '.env') });
dotenv.config({ path: path.join(rootDir, '.env.development') });

/**
 * Multi-provider LLM factory.
 *
 * Provides `createChatModel()` which routes to the correct provider
 * (Vertex AI or Ollama) based on the model string format.
 *
 * Embeddings are always Vertex AI — see module JSDoc for rationale.
 */
export class LLMProvider {
  /** Singleton Vertex AI embeddings instance (reused across calls). */
  private static embeddingsInstance: VertexAIEmbeddings | undefined;

  private constructor() {}

  // ── Chat Model Factory ────────────────────────────────────────────────────

  /**
   * Creates the appropriate chat model for the given model string.
   *
   * Routes to:
   * - `ChatVertexAI` for Gemini/Google models (`gemini-*`, `google:*`, `google-vertexai:*`)
   * - `ChatOllama` for local Ollama models (`ollama:*`)
   *
   * Both implement `BaseChatModel` from `@langchain/core`, so they are
   * drop-in compatible with `createDeepAgent` and all LangChain tools.
   *
   * @param model - The full model string (e.g., "gemini-2.5-flash", "ollama:gemma4").
   * @param temperature - Sampling temperature. Default: 0 (deterministic, good for coding).
   * @returns A configured `BaseChatModel` ready for use.
   * @throws {Error} If using a Vertex AI model without valid credentials.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public static createChatModel(
    model: string,
    temperature = 0,
  ): any {
    if (isOllamaModel(model)) {
      return LLMProvider.createOllamaModel(model, temperature);
    }

    if (isGeminiModel(model) || !model.includes(':')) {
      // Bare model names (no provider prefix) default to Vertex AI
      return LLMProvider.createVertexModel(model, temperature);
    }

    // Unrecognized provider prefix — throw a helpful error
    const provider = model.split(':')[0];
    throw new Error(
      `Unsupported LLM provider: "${provider}". ` +
      `Supported providers: "ollama", "gemini-*" (Vertex AI). ` +
      `Set AGENT_MODEL in your .env file.`,
    );
  }

  // ── Embeddings (always Vertex AI) ─────────────────────────────────────────

  /**
   * Returns the singleton Vertex AI embeddings model.
   *
   * Embeddings are ALWAYS Vertex AI, regardless of the active chat model.
   * See module JSDoc for the architectural rationale.
   *
   * @returns The configured `VertexAIEmbeddings` instance.
   * @throws {Error} If `GOOGLE_APPLICATION_CREDENTIALS` is not set or invalid.
   */
  public static getEmbeddingsModel(): VertexAIEmbeddings {
    if (!LLMProvider.embeddingsInstance) {
      LLMProvider.ensureVertexCredentials();
      LLMProvider.embeddingsInstance = new VertexAIEmbeddings({
        model: 'text-embedding-004',
      });
    }
    return LLMProvider.embeddingsInstance;
  }

  // ── Legacy Compatibility ───────────────────────────────────────────────────

  /**
   * @deprecated Use `createChatModel(model)` instead.
   * Kept for backward compatibility with old code that calls `LLMProvider.getModel()`.
   * Reads `GOOGLE_CLOUD_MODEL_NAME` env var for the model name.
   */
  public static getModel(): ChatVertexAI {
    LLMProvider.ensureVertexCredentials();
    return new ChatVertexAI({
      model: process.env.GOOGLE_CLOUD_MODEL_NAME ?? 'gemini-2.5-flash-lite',
      temperature: 0,
    });
  }

  /**
   * @deprecated Use `createChatModel(model)` instead.
   * Kept for backward compatibility with old code that calls `LLMProvider.createModel()`.
   */
  public static createModel(config?: {
    modelName?: string;
    temperature?: number;
  }): ChatVertexAI {
    LLMProvider.ensureVertexCredentials();
    return new ChatVertexAI({
      model: config?.modelName ?? process.env.GOOGLE_CLOUD_MODEL_NAME ?? 'gemini-2.5-flash-lite',
      temperature: config?.temperature ?? 0,
    });
  }

  // ── Private: Provider Factories ───────────────────────────────────────────

  /**
   * Creates a local `ChatOllama` instance.
   *
   * Strips the `"ollama:"` prefix from the model string before passing it
   * to `ChatOllama`, since the Ollama API only expects the bare model name
   * (e.g., "gemma4", not "ollama:gemma4").
   *
   * @param model - Full model string with `"ollama:"` prefix.
   * @param temperature - Sampling temperature.
   * @returns A configured `ChatOllama` instance.
   */
  /**
   * Creates a local `OllamaChatAdapter` instance.
   *
   * Uses `OllamaChatAdapter` (a transparent `ChatOllama` subclass) instead of
   * raw `ChatOllama`. The adapter serializes any non-string `ToolMessage` content
   * to JSON before forwarding to the Ollama API, which only accepts string content.
   *
   * This fixes the runtime crash:
   *   > Non string tool message content is not supported
   * that occurs when deepagents' built-in tools (e.g., `read_file`) return objects.
   *
   * Strips the `"ollama:"` prefix from the model string before passing it
   * to the adapter, since the Ollama API only expects the bare model name
   * (e.g., "gemma4:e2b", not "ollama:gemma4:e2b").
   *
   * @param model - Full model string with `"ollama:"` prefix.
   * @param temperature - Sampling temperature.
   * @returns A configured `OllamaChatAdapter` instance.
   */
  private static createOllamaModel(model: string, temperature: number): OllamaChatAdapter {
    // Strip "ollama:" prefix → "gemma4:e2b" (what Ollama API expects)
    const bareModelName = model.startsWith('ollama:') ? model.slice('ollama:'.length) : model;

    return new OllamaChatAdapter({
      model: bareModelName,
      baseUrl: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434',
      temperature,
    });
  }

  /**
   * Creates a `ChatVertexAI` instance with credential validation.
   *
   * @param model - The Gemini/Vertex model name (e.g., "gemini-2.5-flash").
   * @param temperature - Sampling temperature.
   * @returns A configured `ChatVertexAI` instance.
   * @throws {Error} If credentials are missing or the credentials file doesn't exist.
   */
  private static createVertexModel(model: string, temperature: number): ChatVertexAI {
    LLMProvider.ensureVertexCredentials();
    return new ChatVertexAI({ model, temperature });
  }

  /**
   * Validates that Google Application Credentials are configured.
   *
   * Resolves the credentials path relative to `process.cwd()` and sets the
   * absolute path back into the environment (required by the Google SDK).
   *
   * @throws {Error} If `GOOGLE_APPLICATION_CREDENTIALS` is not set.
   * @throws {Error} If the credentials file does not exist at the resolved path.
   */
  private static ensureVertexCredentials(): void {
    const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

    if (!credentialsPath) {
      throw new Error(
        '❌ GOOGLE_APPLICATION_CREDENTIALS is not set. ' +
        'For Vertex AI models, add it to your .env file. ' +
        'For local inference, set AGENT_MODEL=ollama:<model> instead.',
      );
    }

    const absoluteCredentialsPath = path.resolve(rootDir, credentialsPath);

    if (!fs.existsSync(absoluteCredentialsPath)) {
      throw new Error(
        `❌ Credentials file not found at: ${absoluteCredentialsPath}. ` +
        'Check your GOOGLE_APPLICATION_CREDENTIALS path in .env.',
      );
    }

    // Normalize to absolute path — the Google SDK requires this.
    process.env.GOOGLE_APPLICATION_CREDENTIALS = absoluteCredentialsPath;
  }
}
