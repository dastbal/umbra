/**
 * The embedding boundary: what Umbra needs from a vector model, and the
 * identity that makes a stored vector interpretable later.
 *
 * ## Why identity travels with the port
 *
 * A vector on its own is not self-describing. Two providers can return the same
 * number of dimensions from completely different vector spaces —
 * `text-embedding-004` (Vertex) and `nomic-embed-text` (Ollama) both return
 * 768 floats — so a cosine similarity computed across them succeeds, returns a
 * plausible score, and ranks the wrong code first. Nothing errors.
 *
 * That is the same shape as ADR-017's third failure: a green line over a bad
 * index. The defence is to make every vector carry who wrote it, and to refuse
 * to compare across identities. Hence {@link EmbeddingsIdentity} is part of the
 * port rather than a detail of an adapter.
 *
 * @example
 * ```ts
 * const port = resolveEmbeddings();
 * const vector = await port.embedQuery('where is the payment webhook handled?');
 * // port.identity.column tells the store which column that vector belongs in.
 * ```
 */

/** Embedding providers Umbra can use. Extending this requires a new column. */
export type EmbeddingsProvider = 'vertex' | 'ollama';

/**
 * Everything needed to decide whether a stored vector may be compared against
 * a freshly computed one.
 */
export interface EmbeddingsIdentity {
  /** Which service produced the vector. */
  readonly provider: EmbeddingsProvider;
  /** The concrete model name, which can change within one provider. */
  readonly model: string;
  /** Vector length. Equal across the current two providers, deliberately recorded anyway. */
  readonly dimensions: number;
  /** The `code_chunks` column this provider's vectors live in. */
  readonly column: EmbeddingVectorColumn;
}

/**
 * The per-provider vector columns of `code_chunks`.
 *
 * > **Superseded as the storage design (ADR-026).** Vectors now live in
 * > `chunk_vectors`, keyed by `(chunk_id, provider, model)` and stored as
 * > float32 BLOBs. These columns are **no longer written or read** by indexing
 * > or retrieval.
 * >
 * > This constant survives for exactly one purpose: it is the list the one-time
 * > migration reads to know where to import legacy vectors *from*. The columns
 * > themselves are deliberately not dropped — they are the rollback.
 *
 * Do not add a new provider here. Under ADR-026 a provider is rows, not a
 * column, and adding one here would write to storage nothing reads.
 */
export const EMBEDDING_VECTOR_COLUMNS = [
  'vector_vertex_json',
  'vector_ollama_json',
] as const;

/** One of the legacy provider-specific vector columns. */
export type EmbeddingVectorColumn = (typeof EMBEDDING_VECTOR_COLUMNS)[number];

/**
 * The oldest column, written before embeddings became pluggable at all.
 *
 * Every value in it came from Vertex, because Vertex was the only provider.
 */
export const LEGACY_VECTOR_COLUMN = 'vector_json';

/**
 * What identity each legacy column's contents actually had.
 *
 * The column design recorded the *provider* by which column a vector sat in,
 * and recorded the **model not at all**. So this mapping is the best available
 * answer for the migration, and it is an assumption rather than a fact: it
 * asserts that each column was written by that provider's default model, which
 * is true of every index this project has produced, because no model override
 * was ever configurable.
 *
 * That gap is itself part of the argument for ADR-026: `chunk_vectors` stores
 * the model in the key, so no future migration has to guess.
 *
 * Declared here, with no imports, so both the adapters and `AgentDB`'s
 * migration read one list instead of two.
 */
export const LEGACY_COLUMN_IDENTITIES: Readonly<
  Record<string, { provider: EmbeddingsProvider; model: string; dimensions: number }>
> = {
  vector_json: { provider: 'vertex', model: 'text-embedding-004', dimensions: 768 },
  vector_vertex_json: { provider: 'vertex', model: 'text-embedding-004', dimensions: 768 },
  vector_ollama_json: { provider: 'ollama', model: 'nomic-embed-text', dimensions: 768 },
};

/**
 * What Umbra requires of an embedding model.
 *
 * Structurally a subset of LangChain's `Embeddings`, so an adapter is a thin
 * wrapper rather than a translation, but declared independently so the RAG
 * layer does not depend on the framework (`AGENTS.md`: the ORM/framework stays
 * behind the port).
 */
export interface EmbeddingsPort {
  /** Who this port is, for stamping and for mismatch detection. */
  readonly identity: EmbeddingsIdentity;

  /**
   * Embeds a single search query.
   *
   * @param text - The natural-language query.
   * @returns The query vector.
   */
  embedQuery(text: string): Promise<number[]>;

  /**
   * Embeds a batch of documents for indexing.
   *
   * @param texts - Document texts, in order.
   * @returns One vector per input, in the same order.
   */
  embedDocuments(texts: string[]): Promise<number[][]>;
}

/**
 * Raised when the active embedding identity cannot read the stored index.
 *
 * Carried as a typed error rather than an empty result set on purpose. The old
 * behaviour — compute similarity over whatever is there — produced confident
 * nonsense; returning zero rows would produce a quieter lie, because "no
 * results" is indistinguishable from "nothing matched your question". Only an
 * explicit error can say *which* provider wrote the index and what to run.
 */
export class EmbeddingsIndexMismatchError extends Error {
  /**
   * @param active - The identity being queried with.
   * @param populated - Identities that actually have vectors stored, if any.
   */
  constructor(
    public readonly active: EmbeddingsIdentity,
    public readonly populated: readonly EmbeddingsProvider[],
  ) {
    const built = populated.length > 0 ? populated.join(', ') : 'no provider';
    super(
      `The code index holds vectors from ${built}, but this query uses ` +
        `${active.provider}/${active.model}. Vectors from different embedding models ` +
        'are not comparable, so no similarity was computed. Re-index with ' +
        `UMBRA_EMBEDDINGS=${active.provider}, or switch back to a provider the index already has.`,
    );
    this.name = 'EmbeddingsIndexMismatchError';
  }
}
