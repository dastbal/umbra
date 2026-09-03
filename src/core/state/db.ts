import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { agentPath } from '../config/agent-directory';
import { runtimeRoot } from '../config/runtime-root';
import { writeLine } from '../observability/console-sink';
import {
  EMBEDDING_VECTOR_COLUMNS,
  LEGACY_COLUMN_IDENTITIES,
  LEGACY_VECTOR_COLUMN,
} from '../rag/embeddings/embeddings.port';
import { encodeLegacyJsonVector, vectorDimensions } from '../rag/vector-codec';
import {
  loadVectorExtension,
  VectorExtensionStatus,
} from './vector-extension';
import { ensureLexicalIndex } from '../rag/lexical-index';
import { ensureRetrievalMemory } from '../rag/retrieval-memory';
import { enrichExistingTSDoc } from '../rag/tsdoc-enrichment';

/**
 * Singleton Database Manager.
 * Handles the connection to the local SQLite instance used for caching and state management.
 */
export class AgentDB {
  private static instance: Database.Database;

  /** Whether SQL-side vector distance is available on this connection. */
  private static vectorExtension: VectorExtensionStatus = { available: false };

  /**
   * Reports whether `vec_distance_cosine` can be used in SQL.
   *
   * Read by `RetrieverService` to choose between ranking in SQL and ranking in
   * JavaScript. Exposed rather than re-probed so both answer from one fact.
   *
   * @returns The extension status for this process.
   */
  public static get vectorSearch(): VectorExtensionStatus {
    return AgentDB.vectorExtension;
  }

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

      // Vector distance in SQL rather than in JavaScript (ADR-026). Allowed to
      // fail: retrieval falls back to scoring in JS over the same BLOBs, and
      // the reason is reported once rather than hidden.
      this.vectorExtension = loadVectorExtension(this.instance);

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

    // Existing embeddings remain valid: this writes only documentation metadata
    // for chunks that can be matched unambiguously to the current source AST.
    // The following FTS setup observes those updates through its normal trigger.
    enrichExistingTSDoc(db, runtimeRoot());

    // FTS5 is a local, deterministic retrieval signal. Its triggers follow
    // `code_chunks`, including foreign-key cascade deletes, so no stale text
    // can survive a real file-content change beside the vector rows.
    ensureLexicalIndex(db);

    // User wording is a local retrieval aid, not code evidence. Its table is
    // deliberately separate from `code_chunks` and has no vector rows.
    ensureRetrievalMemory(db);

    // 4. Chunk Vectors (ADR-026)
    //
    // One row per (chunk, provider, model), holding a float32 BLOB. This
    // replaces the per-provider columns of `code_chunks` as the storage design,
    // for three reasons that the column layout could not deliver:
    //
    //   - **A provider is rows, not schema.** Adding one needs no `ALTER TABLE`.
    //   - **The model is part of the key.** Under the column design, upgrading
    //     `text-embedding-004` to a newer Vertex model would reuse the same
    //     column and mix two unrelated vector spaces again — the exact failure
    //     the columns existed to prevent, arriving from inside one provider.
    //   - **BLOB instead of JSON text.** 3,072 bytes instead of 16,208, and no
    //     parse: measured 1 ms against 1,130 ms to decode 50 vectors 200 times.
    //     It is also the shape `sqlite-vec` needs, which is what lets the
    //     distance computation move out of JavaScript.
    //
    // The cascade is now two levels deep — `chunk_vectors` → `code_chunks` →
    // `file_registry` — and that is intentional. A file whose content changed
    // has stale chunks for *every* provider, so removing them is correct. What
    // must never happen again is treating a provider *switch* as a content
    // change; see `IndexerService#backfillMissingVectors`.
    db.prepare(
      `
      CREATE TABLE IF NOT EXISTS chunk_vectors (
        chunk_id   TEXT    NOT NULL,     -- code_chunks.id
        provider   TEXT    NOT NULL,     -- 'vertex' | 'ollama'
        model      TEXT    NOT NULL,     -- the concrete embedding model
        dimensions INTEGER NOT NULL,     -- component count, for diagnosis
        vector     BLOB    NOT NULL,     -- little-endian float32 components
        PRIMARY KEY (chunk_id, provider, model),
        FOREIGN KEY(chunk_id) REFERENCES code_chunks(id) ON DELETE CASCADE
      )
    `,
    ).run();

    // Retrieval always filters by the active identity before ranking, so this
    // is the index that keeps that filter from scanning the whole table.
    db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_chunk_vectors_identity
         ON chunk_vectors(provider, model)`,
    ).run();

    this.migrateEmbeddingColumns();
    this.migrateVectorsToBlobRows();
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

  /**
   * Imports legacy JSON-text vectors into `chunk_vectors` as float32 BLOBs.
   *
   * ## Why this runs automatically, and why it is safe to
   *
   * An operator who upgrades should not have to re-embed a repository — that
   * cost is exactly what stops people from adopting a change. Every vector
   * already on disk is usable; only its container is wrong.
   *
   * The migration is:
   *
   * - **Idempotent.** `INSERT OR IGNORE` against the `(chunk_id, provider,
   *   model)` primary key, so a chunk already migrated is left alone and a
   *   second run performs no writes.
   * - **Non-destructive.** The three legacy columns are **not** cleared and
   *   **not** dropped. They are the rollback, and the surgeon's rule applies to
   *   storage as much as to code.
   * - **Honest about corruption.** A column value that is not a usable numeric
   *   array is skipped and counted, never coerced into a row that would read as
   *   valid. Silence there would reproduce ADR-017's third failure.
   *
   * `vector_json` is read last so that, for a chunk holding both it and
   * `vector_vertex_json`, the explicit column wins on the primary key and the
   * legacy one is ignored. They carry the same identity, so either is correct;
   * ordering it makes the outcome deterministic rather than incidental.
   *
   * @returns Nothing. Counts are reported through the log sink, because a
   *          migration that moves data and says nothing is unauditable.
   */
  private static migrateVectorsToBlobRows(): void {
    const db = this.instance;

    // Nothing to import into a database that has no legacy columns at all —
    // a fresh install, which is the common case after this ships.
    const columns = new Set(
      (db.prepare(`PRAGMA table_info(code_chunks)`).all() as { name: string }[]).map(
        (column) => column.name,
      ),
    );

    const sources = [...EMBEDDING_VECTOR_COLUMNS, LEGACY_VECTOR_COLUMN].filter((column) =>
      columns.has(column),
    );
    if (sources.length === 0) return;

    const insert = db.prepare(
      `INSERT OR IGNORE INTO chunk_vectors (chunk_id, provider, model, dimensions, vector)
       VALUES (?, ?, ?, ?, ?)`,
    );

    let imported = 0;
    let skipped = 0;

    for (const column of sources) {
      const identity = LEGACY_COLUMN_IDENTITIES[column];
      if (identity === undefined) continue;

      const rows = db
        .prepare(
          `SELECT c.id AS id, c.${column} AS json
             FROM code_chunks c
             WHERE c.${column} IS NOT NULL
               AND NOT EXISTS (
                 SELECT 1 FROM chunk_vectors v
                  WHERE v.chunk_id = c.id AND v.provider = ? AND v.model = ?
               )`,
        )
        .all(identity.provider, identity.model) as { id: string; json: string }[];

      if (rows.length === 0) continue;

      const importMany = db.transaction((batch: { id: string; json: string }[]) => {
        for (const row of batch) {
          const blob = encodeLegacyJsonVector(row.json);
          if (blob === undefined) {
            skipped += 1;
            continue;
          }
          insert.run(
            row.id,
            identity.provider,
            identity.model,
            vectorDimensions(blob),
            blob,
          );
          imported += 1;
        }
      });

      importMany(rows);
    }

    if (imported > 0 || skipped > 0) {
      writeLine(
        `⚙️  [DB] Migrated ${imported} vectors into chunk_vectors` +
          (skipped > 0 ? `; skipped ${skipped} unreadable legacy values` : '') +
          '. The legacy columns were left untouched.',
      );
    }
  }
}
