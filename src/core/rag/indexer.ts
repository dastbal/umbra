import { FileRegistry } from '../state/file-registry';
import { NestChunker } from '../tools/ast/chunker';
import { AgentDB } from '../state/db';
import { runtimeRoot } from '../config/runtime-root';
import { writeFragment, writeLine } from '../observability/console-sink';
import { EmbeddingsPort } from './embeddings';
import { resolveEmbeddings } from './embeddings/embeddings-resolver';
import { readIndexStamp, writeIndexStamp } from './index-stamp';
import * as path from 'path';
import * as fs from 'fs';
import { GraphEdge, ProcessedChunk } from '../types';

/**
 * The Indexer Service (The Orchestrator) 🎼
 * Responsible for keeping the AI memory in sync with the codebase.
 * It coordinates the FileRegistry, AST Parser, and Vector Store.
 */
export class IndexerService {
  private registry: FileRegistry;
  private chunker: NestChunker;
  private db: any; // Type 'any' allowed here for better-sqlite3 instance wrapper
  private static isIndexing = false;

  /**
   * When true, all progress console.log calls are suppressed.
   * Set by the CLI streaming layer so background re-indexing
   * doesn't pollute the token stream output.
   */
  public static silent = false;

  /** Conditional logger — silent when streaming. */
  private static log(...args: unknown[]): void {
    if (!IndexerService.silent) writeLine(args.map((arg) => String(arg)).join(' '));
  }

  // Optimization: Send chunks to Vertex AI in groups to respect rate limits and improve speed.
  private BATCH_SIZE = 10;

  /** The embedding provider whose column this run writes. */
  private readonly embeddings: EmbeddingsPort;

  /**
   * @param embeddings - Embedding port to index with. Defaults to the resolved
   *        provider, so every existing `new IndexerService()` call site keeps
   *        working unchanged.
   */
  constructor(embeddings: EmbeddingsPort = resolveEmbeddings().port) {
    this.registry = new FileRegistry();
    this.chunker = new NestChunker();
    this.db = AgentDB.getInstance();
    this.embeddings = embeddings;
  }

  /**
   * Main Entry Point: Scans the project and updates the brain.
   * Scans files, checks hashes, generates embeddings, and saves the knowledge graph.
   * * @param sourceDir - Relative path to source code (usually 'src').
   */
  public async indexProject(sourceDir: string = 'src') {
    if (IndexerService.isIndexing) {
      writeLine('⏳ Indexing already in progress. Skipping duplicate request.');
      return;
    }
    IndexerService.isIndexing = true;

    try {
      const rootDir = runtimeRoot();
      const fullSourceDir = path.join(rootDir, sourceDir);

      IndexerService.log(`🚀 Starting Indexing Process on: ${sourceDir}`);

    const files = this.getAllFiles(fullSourceDir);
    const filesToProcess: string[] = [];

    // A provider switch invalidates every vector even though no file changed.
    // `FileRegistry` tracks content hashes, so on its own it would report
    // "up to date" right after switching to a provider whose column is empty:
    // the new column would never be written, retrieval would keep failing, and
    // running the indexer again would change nothing. Re-embedding everything
    // is the only correct answer, and it has to be decided here rather than
    // left to the operator to discover.
    const previous = readIndexStamp(rootDir);
    const identity = this.embeddings.identity;
    const providerChanged =
      previous !== undefined &&
      (previous.provider !== identity.provider || previous.model !== identity.model);

    if (previous !== undefined && providerChanged) {
      IndexerService.log(
        `Embeddings changed (${previous.provider}/${previous.model} -> ` +
          `${identity.provider}/${identity.model}). Embedding existing chunks ` +
          'for the new provider; the previous vectors are kept and stay usable ' +
          'if you switch back.',
      );
    }

    // Check changes. A provider switch is deliberately NOT treated as a
    // content change -- see `backfillMissingVectors` for why re-chunking here
    // destroyed the other provider's index.
    for (const file of files) {
      if (this.registry.isFileChanged(file)) {
        filesToProcess.push(file);
      }
    }

    // Chunks that exist but carry no vector for the active provider. This is
    // the whole switch path: after `--embeddings ollama`, every row still
    // holds its content and its Vertex vector, and only the new column is
    // empty.
    const backfilled = await this.backfillMissingVectors();

    if (filesToProcess.length === 0) {
      IndexerService.log(
        backfilled > 0
          ? `✨ Content unchanged; embedded ${backfilled} existing chunks for ${identity.provider}.`
          : '✨ Project is up to date.',
      );
      writeIndexStamp(rootDir, identity, {
        filesIndexed: 0,
        status: 'complete',
      });
      return;
    }

    IndexerService.log(`📦 Found ${filesToProcess.length} files to process.`);

    // --- CAMBIO IMPORTANTE ---
    // Acumuladores separados
    const pendingChunks: ProcessedChunk[] = [];
    const pendingEdges: GraphEdge[] = []; // <--- Acumulamos el grafo aquí

    // 1. PRIMERA PASADA: Registrar archivos y generar datos
    for (const filePath of filesToProcess) {
      await this.processSingleFile(filePath, pendingChunks, pendingEdges);
    }

    // 2. SEGUNDA PASADA: Guardar Grafo (Ahora que todos los archivos existen en registry)
    if (pendingEdges.length > 0) {
      IndexerService.log(`🕸️ Saving ${pendingEdges.length} dependency relations...`);
      this.saveGraph(pendingEdges);
    }

      // 3. TERCERA PASADA: Guardar Vectores
      let embedOutcome = { embeddedBatches: 0, failedBatches: 0 };
      if (pendingChunks.length > 0) {
        embedOutcome = await this.embedAndSaveBatches(pendingChunks);
      }

      // Reporting completion after failed batches is worse than the failure
      // itself: the operator reads a green line, trusts an index that is
      // missing content, and later wonders why semantic search cannot find it.
      IndexerService.log(
        embedOutcome.failedBatches > 0
          ? '⚠️  Indexing finished with gaps — reindex once the cause is fixed.'
          : '✅ Indexing Complete.',
      );

      // Recorded from the same value that was just printed, so the stamp on
      // disk and the line on screen can never disagree about completeness.
      writeIndexStamp(rootDir, identity, {
        filesIndexed: filesToProcess.length,
        status: embedOutcome.failedBatches > 0 ? 'partial' : 'complete',
      });
    } finally {
      IndexerService.isIndexing = false;
    }
  }

  // ==========================================
  // ⚙️ INTERNAL LOGIC
  // ==========================================

  /**
   * Embeds chunks that already exist but have no vector for the active provider.
   *
   * ## Why this exists, and what it replaced
   *
   * The first implementation handled a provider switch by marking every file as
   * needing work and re-running the chunker. That destroyed the previous
   * provider's index, which is the opposite of what ADR-025 promised, and it
   * happened for two reasons that only compound:
   *
   * 1. `FileRegistry#updateFile` issues `INSERT OR REPLACE INTO file_registry`,
   *    and `code_chunks` declares
   *    `FOREIGN KEY(file_path) REFERENCES file_registry(path) ON DELETE CASCADE`.
   *    `INSERT OR REPLACE` **deletes** the parent row before reinserting it, so
   *    every chunk of a re-indexed file is cascade-deleted. Proven directly:
   *    with `PRAGMA foreign_keys` on, which better-sqlite3 sets by default, a
   *    replace on the parent takes the children with it and a true upsert does
   *    not.
   * 2. `NestChunker` assigns `uuidv4()` to every chunk on every run, so a chunk
   *    has no stable identity across runs and `ON CONFLICT(id)` can never fire.
   *    One row could therefore never accumulate two providers' vectors.
   *
   * Measured consequence of the old path on this repository: `vector_json` fell
   * from 232 rows to 5 and `vector_vertex_json` from 45 to 0 while Ollama wrote
   * 252. The Vertex index was gone.
   *
   * The fix is not to defeat either mechanism, because both are correct for what
   * they were written for. **A provider switch is not a content change.** The
   * chunks are already on disk with their text; what is missing is one column.
   * So this reads that text back and fills the column in place — no re-chunk, no
   * new ids, no cascade, no duplicated content, and nothing to go stale.
   *
   * Cascade-on-content-change is deliberately left alone: when a file really has
   * changed, its old chunks are stale for *every* provider and removing them is
   * right.
   *
   * @returns How many chunks were embedded.
   */
  private async backfillMissingVectors(): Promise<number> {
    const column = this.embeddings.identity.column;

    const pending = this.db
      .prepare(
        `SELECT id, content FROM code_chunks WHERE ${column} IS NULL AND content IS NOT NULL`,
      )
      .all() as { id: string; content: string }[];

    if (pending.length === 0) return 0;

    IndexerService.log(
      `\u{1F501} Embedding ${pending.length} existing chunks for ${this.embeddings.identity.provider}...`,
    );

    const update = this.db.prepare(`UPDATE code_chunks SET ${column} = ? WHERE id = ?`);
    const updateMany = this.db.transaction(
      (rows: { id: string }[], vectors: number[][]) => {
        rows.forEach((row, idx) => update.run(JSON.stringify(vectors[idx]), row.id));
      },
    );

    let embedded = 0;
    const failures: string[] = [];

    for (let i = 0; i < pending.length; i += this.BATCH_SIZE) {
      const batch = pending.slice(i, i + this.BATCH_SIZE);

      try {
        const vectors = await this.embeddings.embedDocuments(batch.map((row) => row.content));
        updateMany(batch, vectors);
        embedded += batch.length;
        writeFragment('.');
      } catch (err: unknown) {
        // Counted, not printed per batch: a misconfiguration fails identically
        // every time, and one summary is more useful than N stack traces. Same
        // reasoning as `embedAndSaveBatches`.
        failures.push(err instanceof Error ? err.message : String(err));
      }
    }

    if (failures.length > 0) {
      IndexerService.reportEmbeddingFailures(
        failures,
        Math.ceil(pending.length / this.BATCH_SIZE),
      );
    }

    return embedded;
  }

  /**
   * Processes a single file: Reads content, Calculates Hash, Parses AST,
   * Updates Registry, and Accumulates Chunks.
   */
  private processSingleFile(
    filePath: string,
    chunkAccumulator: ProcessedChunk[],
    edgeAccumulator: GraphEdge[], // <--- Nuevo parámetro
  ) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');

      // A. Calculate Hash
      const hash = require('crypto')
        .createHash('md5')
        .update(content)
        .digest('hex');

      // B. Analyze
      const analysis = this.chunker.analyze(filePath, content, hash);

      // --- CAMBIO CLAVE: ORDEN DE OPERACIONES ---

      // 1. PRIMERO: Registrar el archivo en DB.
      // Si no hacemos esto, el foreign key de 'source' fallará si intentáramos guardar algo.
      this.registry.updateFile(filePath, analysis.skeleton);

      // 2. SEGUNDO: Acumular relaciones para guardarlas DESPUÉS
      // No llamamos a this.saveGraph() aquí.
      edgeAccumulator.push(...analysis.dependencies);

      // 3. TERCERO: Acumular Chunks
      const chunksWithFile = analysis.chunks.map((c) => ({
        ...c,
        filePath: filePath,
      }));

      chunkAccumulator.push(...(chunksWithFile as ProcessedChunk[]));
    } catch (error) {
      writeLine(`❌ Error processing file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Generates embeddings using Vertex AI and saves them to SQLite in transactions.
   */
  private async embedAndSaveBatches(allChunks: ProcessedChunk[]) {
    IndexerService.log(`🧠 Generating Embeddings for ${allChunks.length} chunks...`);

    const failures: string[] = [];
    const batchCount = Math.ceil(allChunks.length / this.BATCH_SIZE);

    for (let i = 0; i < allChunks.length; i += this.BATCH_SIZE) {
      const batch = allChunks.slice(i, i + this.BATCH_SIZE);

      // 1. Prepare Text for Embedding
      const textsToEmbed = batch.map((c) => {
        const metaStr = c.metadata.methodName
          ? `Method: ${c.metadata.methodName}`
          : `Class: ${c.metadata.className}`;
        return `${metaStr}\n${c.content}`;
      });

      let retries = 3;
      let delay = 2000;
      let success = false;

      while (retries > 0 && !success) {
        try {
          // 2. Call the active embedding provider (Vertex, or local Ollama)
          const vectors = await this.embeddings.embedDocuments(textsToEmbed);

          // 3. Save to DB (Transaction for performance)
          //
          // The vector goes in this provider's own column. One shared column
          // would make the index silently unusable after a switch, because
          // vectors from two models are not comparable and a mixed cosine
          // similarity does not error -- it returns a confident, meaningless
          // ranking (ADR-025).
          //
          // `INSERT OR REPLACE` deletes and reinserts the row, which would
          // blank the *other* provider's vector for this chunk -- exactly the
          // forced migration this design exists to avoid. The upsert below
          // touches only this provider's column.
          const vectorColumn = this.embeddings.identity.column;
          const insertChunk = this.db.prepare(`
            INSERT INTO code_chunks (id, file_path, chunk_type, content, ${vectorColumn}, metadata)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              file_path = excluded.file_path,
              chunk_type = excluded.chunk_type,
              content = excluded.content,
              metadata = excluded.metadata,
              ${vectorColumn} = excluded.${vectorColumn}
          `);

          // Explicitly typed transaction callback to fix TS7006
          const insertMany = this.db.transaction(
            (chunks: ProcessedChunk[], vectors: number[][]) => {
              chunks.forEach((chunk, idx) => {
                insertChunk.run(
                  chunk.id,
                  (chunk as any).filePath, // filePath added in processSingleFile
                  chunk.type,
                  chunk.content,
                  JSON.stringify(vectors[idx]), // Serialize vector to string for storage
                  JSON.stringify(chunk.metadata),
                );
              });
            },
          );

          insertMany(batch, vectors);
          // Was `process.stdout.write('.')`. Raw stdout, on the exact path
          // `umbra mcp` runs while warming the index at launch: one dot
          // corrupts the JSON-RPC stream before the handshake completes.
          // ADR-024's evidence did not catch this, because its grep looked
          // for `console.log` only.
          writeFragment('.'); // Visual feedback
          success = true;
          
          // Delay between batches to prevent triggering limits on large projects
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (err: any) {
          retries--;
          if (err.status === 429 || err.message?.includes('429')) {
             writeLine(`\n⚠️ Rate Limit Hit (429). Retrying in ${delay}ms...`);
             await new Promise(resolve => setTimeout(resolve, delay));
             delay *= 2; // Exponential backoff
          } else {
             // Counted, not printed. A misconfiguration fails identically for
             // every batch, and printing the full library stack trace once per
             // batch buried the one line that mattered under fourteen copies of
             // the same error. The summary below reports it once.
             failures.push(err instanceof Error ? err.message : String(err));
             break;
          }
        }
      }
    }

    if (failures.length > 0) {
      IndexerService.reportEmbeddingFailures(failures, batchCount);
      return { embeddedBatches: batchCount - failures.length, failedBatches: failures.length };
    }

    IndexerService.log('\n💾 Vectors Saved.');
    return { embeddedBatches: batchCount, failedBatches: 0 };
  }

  /**
   * Reports embedding failures as one summary rather than one trace per batch.
   *
   * Distinct messages are listed with the number of batches each affected, and
   * only the first line of each is kept — the Google client appends a
   * documentation URL and a stack trace that repeat verbatim every time and say
   * nothing per occurrence.
   *
   * @param failures - One message per failed batch, in order.
   * @param batchCount - Total batches attempted, for the ratio.
   * @returns Nothing.
   */
  private static reportEmbeddingFailures(failures: string[], batchCount: number): void {
    const counts = new Map<string, number>();
    for (const message of failures) {
      const firstLine = message.split('\n')[0]!.trim();
      counts.set(firstLine, (counts.get(firstLine) ?? 0) + 1);
    }

    writeLine(
      `\n❌ Embeddings failed for ${failures.length} of ${batchCount} batches. ` +
      `Semantic search will be incomplete.`,
    );
    for (const [message, count] of counts) {
      writeLine(`   ${message}${count > 1 ? `  (×${count} batches)` : ''}`);
    }
  }

  /**
   * Persists dependency relationships into the graph table.
   * Uses 'INSERT OR IGNORE' to prevent duplicates without errors.
   */
  private saveGraph(edges: GraphEdge[]) {
    if (!edges || edges.length === 0) return;

    const insertEdge = this.db.prepare(`
      INSERT OR IGNORE INTO dependency_graph (source, target, relation)
      VALUES (?, ?, ?)
    `);

    // Explicitly typed transaction callback to fix TS7006
    const runMany = this.db.transaction((edges: GraphEdge[]) => {
      edges.forEach((edge) =>
        insertEdge.run(edge.sourcePath, edge.targetPath, edge.relation),
      );
    });

    runMany(edges);
  }

  /**
   * Recursively gets all .ts files in a directory.
   * Returns RELATIVE paths (e.g., 'src/users/users.service.ts') to ensure consistency in DB.
   */
  private getAllFiles(dir: string, fileList: string[] = []): string[] {
    const files = fs.readdirSync(dir);

    files.forEach((file) => {
      const absolutePath = path.join(dir, file);
      const stat = fs.statSync(absolutePath);

      if (stat.isDirectory()) {
        this.getAllFiles(absolutePath, fileList);
      } else {
        // Filter: Only TS files, ignore tests (.spec.ts)
        if (file.endsWith('.ts') && !file.endsWith('.spec.ts')) {
          // KEY FIX: Normalize to relative path before adding to list
          const relativePath = path.relative(process.cwd(), absolutePath);
          fileList.push(relativePath);
        }
      }
    });

    return fileList;
  }
}
