import { OllamaEmbeddings } from '@langchain/ollama';
import {
  EmbeddingsIdentity,
  EmbeddingsPort,
} from './embeddings.port';

/**
 * Default local embedding model.
 *
 * `nomic-embed-text` is chosen for one reason that matters more than quality
 * benchmarks: it returns 768 dimensions, the same as Vertex's
 * `text-embedding-004`. That does **not** make the two interchangeable — the
 * vector spaces are unrelated — but it means the stored shape is identical, so
 * nothing downstream needs to know which provider filled a column.
 *
 * It also means a mixed comparison would not fail on length, which is exactly
 * why identity is checked explicitly rather than inferred from dimensions.
 */
export const OLLAMA_EMBEDDINGS_MODEL = 'nomic-embed-text';

/** Dimensions returned by {@link OLLAMA_EMBEDDINGS_MODEL}. */
export const OLLAMA_EMBEDDINGS_DIMENSIONS = 768;

/** Where Ollama listens, matching the convention already used for chat. */
export const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434';

/**
 * Resolves the Ollama endpoint from the same environment variable the chat path
 * already honours (`deep-agent-factory.ts`), so a machine that moved Ollama
 * does not have to say so twice.
 *
 * @returns The configured base URL.
 */
export function resolveOllamaBaseUrl(): string {
  return process.env.OLLAMA_BASE_URL ?? OLLAMA_DEFAULT_BASE_URL;
}

/**
 * Local embeddings, with no credentials and no per-query cost.
 *
 * ## Why this exists
 *
 * ADR-024 records, as an accepted negative consequence, that `ask_codebase`
 * "costs cents per query **and cannot run at all without ADC**", and that this
 * directly limits the adoption argument for publishing Umbra over MCP. This
 * adapter is the answer to that: the same tool, answered from the operator's
 * own machine, offline, for free.
 *
 * ## What it does not change
 *
 * Vertex remains the default. Nothing about an existing installation changes
 * until someone explicitly selects `ollama`, and selecting it does not destroy
 * the Vertex index — the two live in separate columns (ADR-025).
 *
 * @example
 * ```ts
 * const port = new OllamaEmbeddingsAdapter();
 * const vector = await port.embedQuery('where do we validate the webhook signature?');
 * ```
 */
export class OllamaEmbeddingsAdapter implements EmbeddingsPort {
  public readonly identity: EmbeddingsIdentity;

  private readonly embeddings: OllamaEmbeddings;

  /**
   * @param model - Embedding model to use; defaults to {@link OLLAMA_EMBEDDINGS_MODEL}.
   * @param baseUrl - Ollama endpoint; defaults to {@link resolveOllamaBaseUrl}.
   */
  constructor(
    model: string = OLLAMA_EMBEDDINGS_MODEL,
    baseUrl: string = resolveOllamaBaseUrl(),
  ) {
    this.identity = {
      provider: 'ollama',
      model,
      dimensions: OLLAMA_EMBEDDINGS_DIMENSIONS,
      column: 'vector_ollama_json',
    };

    this.embeddings = new OllamaEmbeddings({ model, baseUrl });
  }

  /**
   * Embeds one query locally.
   *
   * @param text - The natural-language query.
   * @returns The query vector.
   * @throws When Ollama is unreachable or the model is not pulled. Propagated,
   *         never converted into an empty result: "no vectors" and "no matches"
   *         must not look the same to the caller.
   */
  public async embedQuery(text: string): Promise<number[]> {
    return this.embeddings.embedQuery(text);
  }

  /**
   * Embeds a batch of documents locally.
   *
   * @param texts - Document texts, in order.
   * @returns One vector per input, in the same order.
   */
  public async embedDocuments(texts: string[]): Promise<number[][]> {
    return this.embeddings.embedDocuments(texts);
  }
}
