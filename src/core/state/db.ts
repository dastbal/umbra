import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { agentPath } from '../config/agent-directory';
import { runtimeRoot } from '../config/runtime-root';
import { writeLine } from '../observability/console-sink';
import { EMBEDDING_VECTOR_COLUMNS } from '../rag/embeddings/embeddings.port';

/**
 * Singleton Database Manager.
 * Handles the connection to the local SQLite instance used for caching and state management.
 */
export class AgentDB {
  private static instance: Database.Database;

  /**
   * Private constructor to enforce Singleton pattern.
   */
  private constructor() {}

  /**
   * Retrieves the active database connection.
   * If it doesn't exist, it initializes the DB file and the schema.
   * * @returns {Database.Database} The SQLite connection instance.
   */
  public static getInstance(): Database.Database {
    if (!this.instance) {
      // Read from the pinned runtime root rather than `process.cwd()`. Under
      // the CLI the two are identical; under `umbra mcp` the working directory
      // belongs to the client that spawned the process and says nothing about
      // which repository is being served (ADR-024, constraint 3).
      const rootDir = runtimeRoot();
      const dbDir = agentPath(rootDir); // Hidden folder in project root
      const dbPath = path.join(dbDir, 'memory.db');

      // Ensure directory exists
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }



      this.instance = new Database(dbPath);

      // OPTIMIZATION: Write-Ahead Logging makes writing faster and safer
      this.instance.pragma('journal_mode = WAL');

      this.initSchema();
    }
    return this.instance;
  }

  /**
   * Gracefully closes the active database connection.
   */
  public static close(): void {
    if (this.instance) {
      try {
        this.instance.close();
      } catch (err) {
        writeLine(`Error closing AgentDB: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.instance = undefined as any;
    }
  }

  /**
   * Initializes the database tables based on our architectural plan.
   * 1. file_registry: Tracks file hashes and cached skeletons.
   */
  private static initSchema() {
    const db = this.instance;
    db.prepare(
      `
      CREATE TABLE IF NOT EXISTS file_registry (
        path TEXT PRIMARY KEY,           -- Absolute or relative path (Unique ID)
        hash TEXT NOT NULL,              -- MD5 checksum of the full content
        last_indexed INTEGER NOT NULL,   -- Timestamp (Date.now())
        skeleton_signature TEXT          -- JSON String of the file structure (Class/Methods signatures)
      )
    `,
    ).run();

    // 2. Dependency Graph (Knowledge Graph)
    // Maps how files relate to each other (imports, inheritance).
    db.prepare(
      `
      CREATE TABLE IF NOT EXISTS dependency_graph (
        source TEXT NOT NULL,
        target TEXT NOT NULL,
        relation TEXT NOT NULL,
        PRIMARY KEY (source, target),
        FOREIGN KEY(source) REFERENCES file_registry(path) ON DELETE CASCADE
      )
    `,
    ).run();

    // 3. Code Chunks (Vector Store)
    // Stores the actual code fragments and their vector embeddings.
    // 'vector_json' stores the float array as a JSON string for simplicity in SQLite.
    db.prepare(
      `
      CREATE TABLE IF NOT EXISTS code_chunks (
        id TEXT PRIMARY KEY,        -- UUID
        file_path TEXT NOT NULL,    -- Parent File
        chunk_type TEXT NOT NULL,   -- 'method' | 'file' | 'class'
        content TEXT NOT NULL,      -- The actual code text
        vector_json TEXT,           -- The Embedding [0.1, -0.5, ...]
        metadata TEXT,              -- JSON extra info (decorators, lines)
        FOREIGN KEY(file_path) REFERENCES file_registry(path) ON DELETE CASCADE
      )
    `,
    ).run();

    // Create indexes for faster retrieval
    db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_graph_source ON dependency_graph(source)`,
    ).run();
    db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_chunks_file ON code_chunks(file_path)`,
    ).run();

    this.migrateEmbeddingColumns();
  }

  /**
   * Adds one vector column per embedding provider, additively and idempotently.
   *
   * ## Why one column per provider instead of one shared column
   *
   * Two embedding models produce vectors that are not comparable, and the
   * failure is silent: `nomic-embed-text` and `text-embedding-004` both return
   * 768 floats, so a cosine similarity across them does not error — it returns
   * a credible, meaningless number. Separate columns make the mistake
   * impossible to make rather than merely discouraged (ADR-025).
   *
   * ## Why the legacy `vector_json` column is left in place
   *
   * It is not dead weight, it is the reason no reindex is required. Every value
   * in it was written by Vertex, because Vertex is the only provider that ever
   * existed, so the retriever reads
   * `COALESCE(vector_vertex_json, vector_json)` when the active identity is
   * Vertex. An index built before this change keeps answering afterwards.
   *
   * Switching providers therefore never destroys work: the previous provider's
   * column stays populated and warm, and switching back costs nothing.
   *
   * `ALTER TABLE ... ADD COLUMN` is not conditional in SQLite, so the existing
   * columns are read from `PRAGMA table_info` first. Running this on an
   * already-migrated database performs no writes.
   */
  private static migrateEmbeddingColumns(): void {
    const db = this.instance;

    const existing = new Set(
      (db.prepare(`PRAGMA table_info(code_chunks)`).all() as { name: string }[]).map(
        (column) => column.name,
      ),
    );

    for (const column of EMBEDDING_VECTOR_COLUMNS) {
      if (existing.has(column)) continue;
      db.prepare(`ALTER TABLE code_chunks ADD COLUMN ${column} TEXT`).run();
    }
  }
}
