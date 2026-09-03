import { AgentDB } from '../state/db';
import { cosineSimilarity } from './math';
import { ProcessedChunk } from '../types';
import { writeLine } from '../observability/console-sink';
import {
  EmbeddingsIdentity,
  EmbeddingsIndexMismatchError,
  EmbeddingsPort,
  EmbeddingsProvider,
} from './embeddings';
import { resolveEmbeddings } from './embeddings/embeddings-resolver';
import { decodeVector, encodeVector } from './vector-codec';
import {
  findLexicalCandidates,
  hasExactLexicalEvidence,
} from './lexical-index';
import {
  fuseRankings,
  hasGroundedEvidence,
  RetrievalEvidence,
} from './hybrid-ranking';
import {
  PendingRetrievalAlias,
  RetrievalMemoryService,
  normalizeRetrievalTerms,
} from './retrieval-memory';
import * as path from 'path';
export interface SearchResult {
  chunk: ProcessedChunk;
  score: number;
  evidence: RetrievalEvidence;
  lexicalExact: boolean;
}

/**
 * Where an answer came from, so a caller never has to assume the index is fresh
 * or complete.
 *
 * ADR-017's third failure was an index that reported success while missing
 * content. Under `umbra mcp` the reader of that lie is another agent, which
 * cannot inspect the terminal to find out. So provenance travels with the
 * result.
 */
export interface RetrievalProvenance {
  /** Provider that wrote the vectors being searched. */
  readonly provider: EmbeddingsProvider;
  /** Model that wrote them. */
  readonly model: string;
  /** How many chunks were actually compared. */
  readonly chunksSearched: number;
  /** Component count of the stored vectors, for diagnosing a changed model. */
  readonly dimensions: number;
  /**
   * Where the distance was computed.
   *
   * `'sql'` means only the returned rows crossed into JavaScript; `'javascript'`
   * means `sqlite-vec` could not load and every stored vector was read. Worth
   * surfacing, because the two differ by orders of magnitude on a large
   * repository and produce identical-looking results.
   */
  readonly rankedIn: 'sql' | 'javascript';
}

interface FileContext {
  filePath: string;
  evidence: RetrievalEvidence;
  chunks: ProcessedChunk[];
  imports: string[];
  skeleton?: string; // <--- ADDED
}

/**
 * Chooses the strongest evidence label for a file that owns several chunks.
 *
 * @param current - Evidence already associated with the file.
 * @param next - Evidence of a newly added chunk.
 * @returns The strongest available evidence label.
 */
function strongerEvidence(current: RetrievalEvidence, next: RetrievalEvidence): RetrievalEvidence {
  const priority: Record<RetrievalEvidence, number> = {
    semantic: 1,
    lexical: 2,
    hybrid: 3,
  };
  return priority[next] > priority[current] ? next : current;
}

/**
 * Formats an explicit abstention without leaking an ungrounded file path or
 * agent-only next-step hint.
 *
 * @param query - The request that lacked grounded support.
 * @returns A client-safe retrieval report.
 */
export function noGroundedEvidenceReport(query: string): string {
  return [
    '🔎 **RAG ANALYSIS REPORT**',
    `Query: "${query}"`,
    '',
    '⚠️ **NO GROUNDED EVIDENCE:** Semantic neighbours alone did not have independent lexical support. Refine the query with a symbol, path, or domain term.',
  ].join('\n');
}

export class RetrieverService {
  private db = AgentDB.getInstance();

  private readonly retrievalMemory = new RetrievalMemoryService(this.db);

  private readonly embeddings: EmbeddingsPort;

  /** Provenance of the most recent {@link query}, if one has run. */
  private lastProvenance?: RetrievalProvenance;

  /** `provider/model` identities seen the last time the index was inspected. */
  private lastPopulatedIdentities: readonly string[] = [];

  /** A contextual success eligible for explicit CLI approval. */
  private lastLearningCandidate?: PendingRetrievalAlias;

  /**
   * @param embeddings - Embedding port to search with. Defaults to the resolved
   *        provider, so existing callers such as `askCodebaseTool` — which do
   *        `new RetrieverService()` — keep working unchanged. The parameter is
   *        the injection seam tests and the MCP adapter use.
   */
  constructor(embeddings: EmbeddingsPort = resolveEmbeddings().port) {
    this.embeddings = embeddings;
  }

  /** The active embedding identity, for stamping and for diagnostics. */
  public get identity(): EmbeddingsIdentity {
    return this.embeddings.identity;
  }

  /** Provenance of the most recent successful query. */
  public get provenance(): RetrievalProvenance | undefined {
    return this.lastProvenance;
  }

  /** Contextual success that may become an alias only after CLI approval. */
  public get learningCandidate(): PendingRetrievalAlias | undefined {
    return this.lastLearningCandidate;
  }

  /**
   * Searches the codebase using Vector Embeddings (Cosine Similarity).
   *
   * Only vectors written by the **active** provider are read. Comparing across
   * providers is not merely inaccurate, it is undetectable: `nomic-embed-text`
   * and `text-embedding-004` are both 768-dimensional, so a mixed cosine
   * returns a confident, meaningless ranking. When the active identity has no
   * vectors and another does, this throws rather than returning nothing — "no
   * vectors for this provider" and "nothing matched your question" must not
   * look the same.
   *
   * The distance is computed in SQL when `sqlite-vec` loaded, so only the rows
   * that won cross into JavaScript; otherwise it falls back to scoring the same
   * BLOBs here. `provenance.rankedIn` says which ran.
   *
   * @param query - The natural language query.
   * @param limit - Max chunks to retrieve.
   * @returns Fused chunks, best first.
   * @throws {EmbeddingsIndexMismatchError} When the active provider has no vectors.
   */
  public async query(
    query: string,
    limit: number = 5,
  ): Promise<SearchResult[]> {
    const retrievalQuery = this.retrievalMemory.expand(query);
    writeLine(`🔍 [RAG] Embedding Query: "${query}"...`);

    const identity = this.embeddings.identity;

    // Checked before embedding, deliberately. The old order embedded first and
    // discovered the problem after, so an unusable index cost a paid API call
    // and needed credentials just to diagnose (ADR-025 §4). This probe reads one
    // row through `idx_chunk_vectors_identity`.
    //
    // Nothing coalesces across providers: the legacy `code_chunks` columns were
    // imported into `chunk_vectors` by `AgentDB`'s migration, so an index built
    // before ADR-026 answers here without a reindex, and those columns are
    // never consulted at query time.
    const present = this.db
      .prepare(
        `SELECT dimensions FROM chunk_vectors
          WHERE provider = ? AND model = ? LIMIT 1`,
      )
      .get(identity.provider, identity.model) as { dimensions?: number } | undefined;

    if (present === undefined) {
      throw new EmbeddingsIndexMismatchError(identity, this.populatedProviders());
    }

    const queryVector = await this.embeddings.embedQuery(retrievalQuery);

    // A model that changed its output shape inside one provider. Caught here
    // because `vec_distance_cosine` would otherwise fail with a message about
    // byte lengths, which tells the operator nothing about what to do.
    if (present.dimensions !== undefined && present.dimensions !== queryVector.length) {
      throw new Error(
        `The index holds ${present.dimensions}-dimension vectors for ` +
          `${identity.provider}/${identity.model}, but this query produced ` +
          `${queryVector.length}. The model changed shape; re-index with ` +
          `UMBRA_EMBEDDINGS=${identity.provider}.`,
      );
    }

    const dimensions = present.dimensions ?? queryVector.length;

    const candidateLimit = Math.max(limit, 12);
    const semantic = AgentDB.vectorSearch.available
      ? this.rankInSql(queryVector, candidateLimit, identity, dimensions)
      : this.rankInJavaScript(queryVector, candidateLimit, identity, dimensions);

    const lexical = findLexicalCandidates(this.db, retrievalQuery, candidateLimit);
    const lexicalRows = this.loadChunks(lexical.map((candidate) => candidate.chunkId));
    const byId = new Map<string, SearchResult>();

    semantic.forEach((result) => byId.set(result.chunk.id, result));
    lexicalRows.forEach((result) => byId.set(result.chunk.id, result));

    return fuseRankings(
      semantic.map((result) => ({ id: result.chunk.id, lexicalExact: false })),
      lexical.map((candidate) => {
        const result = byId.get(candidate.chunkId);
        return {
          id: candidate.chunkId,
          lexicalExact:
            result !== undefined &&
            hasExactLexicalEvidence(
              retrievalQuery,
              result.chunk.filePath ?? '',
              JSON.stringify(result.chunk.metadata),
            ),
        };
      }),
      limit,
    ).flatMap((candidate) => {
      const result = byId.get(candidate.id);
      return result === undefined
        ? []
        : [
            {
              ...result,
              score: candidate.score,
              evidence: candidate.evidence,
              lexicalExact: candidate.lexicalExact,
            },
          ];
    });
  }

  /**
   * Ranks by computing the distance inside SQLite.
   *
   * Only the `k` winning rows are ever marshalled into JavaScript. That is the
   * whole point: without it every stored vector crosses the process boundary on
   * every query — 146 MB on a 50,000-chunk repository, even as BLOBs.
   *
   * `vec_distance_cosine` returns a distance, so the score reported here is
   * `1 - distance`. Verified against `cosineSimilarity` on real vectors from
   * this index: the two agree to 4.4e-7, which is float32 rounding and far
   * below anything a ranking could notice.
   *
   * @param queryVector - The embedded query.
   * @param limit - How many chunks to return.
   * @param identity - The active embedding identity.
   * @param dimensions - Stored vector length.
   * @returns Scored chunks, best first.
   */
  private rankInSql(
    queryVector: number[],
    limit: number,
    identity: EmbeddingsIdentity,
    dimensions: number,
  ): SearchResult[] {
    const rows = this.db
      .prepare(
        `SELECT c.id AS id, c.file_path AS file_path, c.chunk_type AS chunk_type,
                c.content AS content, c.metadata AS metadata,
                vec_distance_cosine(v.vector, ?) AS distance
           FROM chunk_vectors v
           JOIN code_chunks c ON c.id = v.chunk_id
          WHERE v.provider = ? AND v.model = ?
          ORDER BY distance
          LIMIT ?`,
      )
      .all(encodeVector(queryVector), identity.provider, identity.model, limit) as any[];

    this.lastProvenance = {
      provider: identity.provider,
      model: identity.model,
      // The comparison happened in C and its width was never materialised here.
      // Reporting a scanned count would be a guess, so this reports the rows it
      // actually received.
      chunksSearched: rows.length,
      dimensions,
      rankedIn: 'sql',
    };

    return rows.map((row) => this.toSearchResult(row, 1 - Number(row.distance)));
  }

  /**
   * Ranks in JavaScript, over the same BLOBs.
   *
   * The fallback when `sqlite-vec` could not load — an unsupported platform, or
   * a `better-sqlite3` built without extension support. It still reads 5.3×
   * fewer bytes than the JSON text it replaced and skips parsing entirely, so
   * the degraded path is not a slow path in absolute terms.
   *
   * @param queryVector - The embedded query.
   * @param limit - How many chunks to return.
   * @param identity - The active embedding identity.
   * @param dimensions - Stored vector length.
   * @returns Scored chunks, best first.
   */
  private rankInJavaScript(
    queryVector: number[],
    limit: number,
    identity: EmbeddingsIdentity,
    dimensions: number,
  ): SearchResult[] {
    const rows = this.db
      .prepare(
        `SELECT c.id AS id, c.file_path AS file_path, c.chunk_type AS chunk_type,
                c.content AS content, c.metadata AS metadata, v.vector AS vector
           FROM chunk_vectors v
           JOIN code_chunks c ON c.id = v.chunk_id
          WHERE v.provider = ? AND v.model = ?`,
      )
      .all(identity.provider, identity.model) as any[];

    this.lastProvenance = {
      provider: identity.provider,
      model: identity.model,
      chunksSearched: rows.length,
      dimensions,
      rankedIn: 'javascript',
    };

    const scored = rows.map((row) => {
      // A typed-array view over the stored bytes: no JSON parse, and no copy of
      // the components. Decoding 50 vectors 200 times measured 1 ms this way
      // against 1,130 ms through `JSON.parse` (ADR-026).
      const vector = decodeVector(row.vector as Buffer);
      return this.toSearchResult(row, cosineSimilarity(queryVector, vector));
    });

    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /**
   * Builds one search result from a joined row.
   *
   * @param row - A row carrying the chunk columns.
   * @param score - Similarity, where 1 is identical.
   * @returns The scored chunk.
   */
  private toSearchResult(row: any, score: number): SearchResult {
    const metadata = JSON.parse(row.metadata);

    return {
      score,
      evidence: 'semantic',
      lexicalExact: false,
      chunk: {
        id: row.id,
        type: row.chunk_type,
        content: row.content,
        metadata,
        // Ensure filePath is recovered from the DB row or metadata
        filePath: row.file_path || metadata.filePath,
      } as ProcessedChunk,
    };
  }

  /**
   * Loads chunks selected by FTS5 while preserving no database-specific type
   * outside this infrastructure boundary.
   *
   * @param ids - Chunk ids selected by lexical ranking.
   * @returns Loaded chunks, in no particular order.
   */
  private loadChunks(ids: readonly string[]): SearchResult[] {
    if (ids.length === 0) return [];

    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT id, file_path, chunk_type, content, metadata
           FROM code_chunks
          WHERE id IN (${placeholders})`,
      )
      .all(...ids) as any[];

    return rows.map((row) => this.toSearchResult(row, 0));
  }

  /**
   * Reports which providers actually have vectors stored.
   *
   * Used only to build a useful error: knowing the index was written by Vertex
   * is the difference between "re-index" and "switch back", and guessing costs
   * the operator a full reindex they may not have needed.
   *
   * @returns Providers with at least one stored vector.
   */
  private populatedProviders(): EmbeddingsProvider[] {
    try {
      // One grouped read replaces the per-column probes the previous design
      // needed, and for the first time it can report the *model* too — which
      // matters, because a model upgrade inside one provider is now a distinct
      // identity that can be present or absent on its own.
      const rows = this.db
        .prepare(`SELECT DISTINCT provider, model FROM chunk_vectors`)
        .all() as { provider: string; model: string }[];

      this.lastPopulatedIdentities = rows.map((row) => `${row.provider}/${row.model}`);

      const providers = new Set<EmbeddingsProvider>();
      for (const row of rows) {
        if (row.provider === 'vertex' || row.provider === 'ollama') {
          providers.add(row.provider);
        }
      }

      return [...providers];
    } catch (error) {
      // Reported rather than silently ignored: a broken vector table would
      // otherwise look identical to an empty one, and the operator would be
      // told to re-index when the real problem is the schema.
      writeLine(
        `⚙️  [RAG] Could not inspect chunk_vectors: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }

  /**
   * `provider/model` identities found the last time the index was inspected.
   *
   * Populated as a side effect of building a mismatch error, which is the only
   * moment the question is asked.
   */
  public get populatedIdentities(): readonly string[] {
    return this.lastPopulatedIdentities;
  }

  /**
   * Retrieves the 'Skeleton' (Signatures) for a file from the registry.
   */
  private getFileSkeleton(sourcePath: string): string | undefined {
    const normalizedPath = sourcePath.split(path.sep).join('/');
    try {
      const stmt = this.db.prepare(
        'SELECT skeleton_signature FROM file_registry WHERE path = ? OR path = ?',
      );
      const result = stmt.get(normalizedPath, sourcePath) as any;
      return result?.skeleton_signature;
    } catch (error) {
      writeLine(
        `❌ [RAG] Error fetching skeleton for ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  /**
   * Retrieves the 'Graph Dependencies' for a specific file from the DB.
   * This allows the Agent to know what other files are related (DTOs, Interfaces).
   */
  private getDependencies(sourcePath: string): string[] {
    // 1. IMPORTANTE: Normalizar la ruta para que coincida con lo guardado en DB
    // Esto convierte "src\module\..." a "src/module/..."
    const normalizedPath = sourcePath.split(path.sep).join('/');
    try {
      // 2. Consultar la tabla dependency_graph que definiste en AgentDB
      // Buscamos todo lo que este archivo (source) importa (target)
      const stmt = this.db.prepare(`
            SELECT target 
            FROM dependency_graph 
            WHERE source = ? OR source = ?
        `);

      // Probamos con la ruta normalizada y la original por si acaso
      const results = stmt.all(normalizedPath, sourcePath) as {
        target: string;
      }[];

      // 3. Devolver solo los strings de los targets
      return results.map((row) => row.target);
    } catch (error) {
      writeLine(
        `❌ [RAG] Error fetching dependencies for ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }

  /**
   * Generates a Rich Context Report for the LLM.
   * It combines:
   * 1. The matched code snippets (Vector Search).
   * 2. The file's dependencies (Graph Search).
   * 3. Explicit File Paths to encourage using 'read_file'.
   */
  public async getContextForLLM(query: string, context?: string): Promise<string> {
    this.lastLearningCandidate = undefined;
    let results = await this.query(query, 4);
    const clarified = context?.trim();
    let recoveredWithContext = false;

    // A clarification earns exactly one additional hybrid lookup. It is never
    // indexed as code and cannot spin into an embedding-cost loop.
    if (!hasGroundedEvidence(results) && clarified !== undefined && clarified.length > 0) {
      results = await this.query(`${query}\n${clarified}`, 4);
      recoveredWithContext = hasGroundedEvidence(results);
    }

    if (!hasGroundedEvidence(results)) {
      return noGroundedEvidenceReport(query);
    }

    if (recoveredWithContext && clarified !== undefined) {
      this.lastLearningCandidate = {
        triggerTerms: normalizeRetrievalTerms(query),
        contextTerms: normalizeRetrievalTerms(clarified),
        verifiedPaths: [...new Set(results.map((result) => result.chunk.filePath).filter(
          (filePath): filePath is string => filePath !== undefined,
        ))].slice(0, 4),
      };
    }

    // Group chunks by File to provide a structured view
    const filesMap = new Map<string, FileContext>();

    for (const res of results) {
      const path = res.chunk.filePath || 'unknown';
      // console.log(res);
      // console.log(path);
      // console.log(this.getDependencies(path));
      if (!filesMap.has(path)) {
        filesMap.set(path, {
          filePath: path,
          evidence: res.evidence,
          chunks: [],
          imports: this.getDependencies(path), // <--- GRAPH MAGIC 🕸️
          skeleton: this.getFileSkeleton(path), // <--- STRUCTURAL MAGIC 🏗️
        });
      }
      const current = filesMap.get(path);
      if (current !== undefined) {
        current.evidence = strongerEvidence(current.evidence, res.evidence);
      }
      filesMap.get(path)?.chunks.push(res.chunk);
    }

    // Build the formatted string
    let output = `🔎 **RAG ANALYSIS REPORT**\n`;
    output += `Query: "${query}"\n`;
    output += `Found ${filesMap.size} relevant files.\n\n`;

    filesMap.forEach((fileCtx) => {
      output += `=================================================================\n`;
      output += `📂 **FILE:** ${fileCtx.filePath}\n`;
      output += `🔎 **MATCH:** ${fileCtx.evidence}\n`;

      if (fileCtx.imports.length > 0) {
        output += `🔗 **DEPENDENCIES (Imports):**\n`;
        // Show top 5 imports to give context on DTOs/Entities used
        fileCtx.imports
          .slice(0, 5)
          .forEach((imp) => (output += `   - ${imp}\n`));
        if (fileCtx.imports.length > 5)
          output += `   - (...and ${fileCtx.imports.length - 5} more)\n`;
      }

      if (fileCtx.skeleton) {
        output += `🏗️ **FILE SKELETON (MAP):**\n${fileCtx.skeleton}\n\n`;
      }

      output += `📝 **CODE SNIPPETS:**\n`;
      fileCtx.chunks.forEach((chunk) => {
        output += `   --- [${chunk.metadata.methodName || 'Class Structure'}] ---\n`;
        output += `${chunk.content.trim()}\n\n`;
      });

      output += `💡 **AGENT HINT:** To edit this file or see full imports, run: read_file("${fileCtx.filePath}")\n`;
      output += `=================================================================\n\n`;
    });
    // console.log(output);

    return output;
  }
}
