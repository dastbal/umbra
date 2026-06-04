import { FileRegistry } from '../state/file-registry';
import { NestChunker } from '../tools/ast/chunker';
import { AgentDB } from '../state/db';
import { LLMProvider } from '../llm/provider';
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
    if (!IndexerService.silent) console.log(...args);
  }

  // Optimization: Send chunks to Vertex AI in groups to respect rate limits and improve speed.
  private BATCH_SIZE = 10;

  constructor() {
    this.registry = new FileRegistry();
    this.chunker = new NestChunker();
    this.db = AgentDB.getInstance();
  }

  /**
   * Main Entry Point: Scans the project and updates the brain.
   * Scans files, checks hashes, generates embeddings, and saves the knowledge graph.
   * * @param sourceDir - Relative path to source code (usually 'src').
   */
  public async indexProject(sourceDir: string = 'src') {
    if (IndexerService.isIndexing) {
      console.log('⏳ Indexing already in progress. Skipping duplicate request.');
      return;
    }
    IndexerService.isIndexing = true;

    try {
      const rootDir = process.cwd();
      const fullSourceDir = path.join(rootDir, sourceDir);

      IndexerService.log(`🚀 Starting Indexing Process on: ${sourceDir}`);

    const files = this.getAllFiles(fullSourceDir);
    const filesToProcess: string[] = [];

    // Check changes
    for (const file of files) {
      if (this.registry.isFileChanged(file)) {
        filesToProcess.push(file);
      }
    }

    if (filesToProcess.length === 0) {
      IndexerService.log('✨ Project is up to date.');
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
      if (pendingChunks.length > 0) {
        await this.embedAndSaveBatches(pendingChunks);
      }

      IndexerService.log('✅ Indexing Complete.');
    } finally {
      IndexerService.isIndexing = false;
    }
  }

  // ==========================================
  // ⚙️ INTERNAL LOGIC
  // ==========================================

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
      console.error(`❌ Error processing file ${filePath}:`, error);
    }
  }

  /**
   * Generates embeddings using Vertex AI and saves them to SQLite in transactions.
   */
  private async embedAndSaveBatches(allChunks: ProcessedChunk[]) {
    IndexerService.log(`🧠 Generating Embeddings for ${allChunks.length} chunks...`);

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
          // 2. Call Vertex AI (Embeddings API)
          const embeddingsModel = LLMProvider.getEmbeddingsModel();
          const vectors = await embeddingsModel.embedDocuments(textsToEmbed);

          // 3. Save to DB (Transaction for performance)
          const insertChunk = this.db.prepare(`
            INSERT OR REPLACE INTO code_chunks (id, file_path, chunk_type, content, vector_json, metadata)
            VALUES (?, ?, ?, ?, ?, ?)
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
          process.stdout.write('.'); // Visual feedback
          success = true;
          
          // Delay between batches to prevent triggering limits on large projects
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (err: any) {
          retries--;
          if (err.status === 429 || err.message?.includes('429')) {
             console.log(`\n⚠️ Rate Limit Hit (429). Retrying in ${delay}ms...`);
             await new Promise(resolve => setTimeout(resolve, delay));
             delay *= 2; // Exponential backoff
          } else {
             console.error('\n❌ Embedding Error:', err);
             break;
          }
        }
      }
    }
    IndexerService.log('\n💾 Vectors Saved.');
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
