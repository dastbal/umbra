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
import { decodeVector } from './vector-codec';
import * as path from 'path';
interface SearchResult {
  chunk: ProcessedChunk;
  score: number;
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
}

interface FileContext {
  filePath: string;
  relevance: number;
  chunks: ProcessedChunk[];
  imports: string[];
  skeleton?: string; // <--- ADDED
}

export class RetrieverService {
  private db = AgentDB.getInstance();

  private readonly embeddings: EmbeddingsPort;

  /** Provenance of the most recent {@link query}, if one has run. */
  private lastProvenance?: RetrievalProvenance;

  /** `provider/model` identities seen the last time the index was inspected. */
  private lastPopulatedIdentities: readonly string[] = [];

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

  /**
   * Searches the codebase using Vector Embeddings (Cosine Similarity).
   *
   * Only vectors written by the **active** provider are read. Comparing across
   * providers is not merely inaccurate, it is undetectable: `nomic-embed-text`
   * and `text-embedding-004` are both 768-dimensional, so a mixed cosine
   * returns a confident, meaningless ranking. When the active column is empty
   * and another provider's is not, this throws rather than returning nothing —
   * "no vectors for this provider" and "nothing matched your question" must not
   * look the same.
   *
   * @param query - The natural language query.
   * @param limit - Max chunks to retrieve.
   * @returns Scored chunks, best first.
   * @throws {EmbeddingsIndexMismatchError} When the active provider has no vectors.
   */
  public async query(
    query: string,
    limit: number = 5,
  ): Promise<SearchResult[]> {
    writeLine(`🔍 [RAG] Embedding Query: "${query}"...`);

    const identity = this.embeddings.identity;

    // Vectors live in `chunk_vectors`, keyed by (chunk, provider, model), and
    // only this identity's rows are read. Nothing coalesces across providers:
    // the legacy `code_chunks` columns were imported into this table by
    // `AgentDB`'s migration, so an index built before ADR-026 answers here with
    // no reindex, and those columns are never consulted at query time.
    const rows = this.db
      .prepare(
        `SELECT c.id AS id, c.file_path AS file_path, c.chunk_type AS chunk_type,
                c.content AS content, c.metadata AS metadata, v.vector AS vector
           FROM chunk_vectors v
           JOIN code_chunks c ON c.id = v.chunk_id
          WHERE v.provider = ? AND v.model = ?`,
      )
      .all(identity.provider, identity.model) as any[];

    if (rows.length === 0) {
      throw new EmbeddingsIndexMismatchError(identity, this.populatedProviders());
    }

    const queryVector = await this.embeddings.embedQuery(query);

    this.lastProvenance = {
      provider: identity.provider,
      model: identity.model,
      chunksSearched: rows.length,
      dimensions: decodeVector(rows[0].vector as Buffer).length,
    };

    const scoredChunks: SearchResult[] = rows.map((row) => {
      // A typed-array view over the stored bytes: no JSON parse, and no copy of
      // the components. Decoding 50 vectors 200 times measured 1 ms this way
      // against 1,130 ms through `JSON.parse` (ADR-026).
      const vector = decodeVector(row.vector as Buffer);
      const score = cosineSimilarity(queryVector, vector);
      const metadata = JSON.parse(row.metadata);

      return {
        score,
        chunk: {
          id: row.id,
          type: row.chunk_type,
          content: row.content,
          metadata: metadata,
          // Ensure filePath is recovered from the DB row or metadata
          filePath: row.file_path || metadata.filePath,
        } as ProcessedChunk,
      };
    });

    return scoredChunks.sort((a, b) => b.score - a.score).slice(0, limit);
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
  public async getContextForLLM(query: string): Promise<string> {
    const results = await this.query(query, 4);

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
          relevance: res.score,
          chunks: [],
          imports: this.getDependencies(path), // <--- GRAPH MAGIC 🕸️
          skeleton: this.getFileSkeleton(path), // <--- STRUCTURAL MAGIC 🏗️
        });
      }
      filesMap.get(path)?.chunks.push(res.chunk);
    }

    // Build the formatted string
    let output = `🔎 **RAG ANALYSIS REPORT**\n`;
    output += `Query: "${query}"\n`;
    output += `Found ${filesMap.size} relevant files.\n\n`;

    filesMap.forEach((fileCtx) => {
      const relevancePct = (fileCtx.relevance * 100).toFixed(1);

      output += `=================================================================\n`;
      output += `📂 **FILE:** ${fileCtx.filePath}\n`;
      output += `📊 **RELEVANCE:** ${relevancePct}%\n`;

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
