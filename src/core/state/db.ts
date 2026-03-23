import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';

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
      const rootDir = process.cwd();
      const dbDir = path.join(rootDir, '.agent'); // Hidden folder in project root
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
  }
}
