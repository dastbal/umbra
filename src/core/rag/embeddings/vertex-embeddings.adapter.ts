import { LLMProvider } from '../../llm/provider';
import {
  EmbeddingsIdentity,
  EmbeddingsPort,
} from './embeddings.port';

/**
 * Model name Vertex has always used here. Recorded as a constant because it is
 * now part of a stored vector's identity, not just a construction argument.
 */
export const VERTEX_EMBEDDINGS_MODEL = 'text-embedding-004';

/** `text-embedding-004` returns 768 dimensions. */
export const VERTEX_EMBEDDINGS_DIMENSIONS = 768;

/** The identity every vector written by this adapter carries. */
export const VERTEX_EMBEDDINGS_IDENTITY: EmbeddingsIdentity = {
  provider: 'vertex',
  model: VERTEX_EMBEDDINGS_MODEL,
  dimensions: VERTEX_EMBEDDINGS_DIMENSIONS,
  column: 'vector_vertex_json',
};

/**
 * Umbra's original embedding path, unchanged, behind the port.
 *
 * `LLMProvider.getEmbeddingsModel` is deliberately not modified: it caches the
 * client, resolves the Google project the way ADR-017 decided, and calls
 * `ensureVertexCredentials` first. All of that keeps working exactly as before.
 * This class only gives that behaviour an identity and a stable interface.
 *
 * Cost and credentials are the reason ADR-024 could not publish `ask_codebase`
 * freely: every call here spends and requires ADC. That is not a defect of this
 * adapter — it is why the Ollama one exists beside it.
 *
 * @example
 * ```ts
 * const port = new VertexEmbeddingsAdapter();
 * const vectors = await port.embedDocuments(['class PaymentService { ... }']);
 * ```
 */
export class VertexEmbeddingsAdapter implements EmbeddingsPort {
  public readonly identity = VERTEX_EMBEDDINGS_IDENTITY;

  /**
   * Embeds one query through Vertex AI.
   *
   * @param text - The natural-language query.
   * @returns The query vector.
   * @throws When ADC is absent or the project cannot be resolved; the error is
   *         propagated rather than swallowed, so the caller can report *why*
   *         retrieval is unavailable instead of reporting no results.
   */
  public async embedQuery(text: string): Promise<number[]> {
    return LLMProvider.getEmbeddingsModel().embedQuery(text);
  }

  /**
   * Embeds a batch of documents through Vertex AI.
   *
   * @param texts - Document texts, in order.
   * @returns One vector per input, in the same order.
   */
  public async embedDocuments(texts: string[]): Promise<number[][]> {
    return LLMProvider.getEmbeddingsModel().embedDocuments(texts);
  }
}
