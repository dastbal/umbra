import Database from 'better-sqlite3';

/** A lexical candidate returned by the local FTS index. */
export interface LexicalCandidate {
  readonly chunkId: string;
  readonly rank: number;
}

const MAX_QUERY_TERMS = 12;

/**
 * Creates and backfills the local full-text index for code chunks.
 *
 * The triggers deliberately live beside the table definition: a file-content
 * change deletes chunks through a foreign-key cascade, which cannot leave a
 * separate search index to remember stale text.
 *
 * @param db - The SQLite connection that owns `code_chunks`.
 * @returns Nothing.
 */
export function ensureLexicalIndex(db: Database.Database): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS code_chunks_fts USING fts5(
      chunk_id UNINDEXED,
      file_path,
      metadata,
      content,
      tokenize = 'unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS code_chunks_fts_insert
    AFTER INSERT ON code_chunks BEGIN
      INSERT INTO code_chunks_fts (chunk_id, file_path, metadata, content)
      VALUES (NEW.id, NEW.file_path, COALESCE(NEW.metadata, ''), NEW.content);
    END;

    CREATE TRIGGER IF NOT EXISTS code_chunks_fts_delete
    AFTER DELETE ON code_chunks BEGIN
      DELETE FROM code_chunks_fts WHERE chunk_id = OLD.id;
    END;

    CREATE TRIGGER IF NOT EXISTS code_chunks_fts_update
    AFTER UPDATE OF file_path, metadata, content ON code_chunks BEGIN
      DELETE FROM code_chunks_fts WHERE chunk_id = OLD.id;
      INSERT INTO code_chunks_fts (chunk_id, file_path, metadata, content)
      VALUES (NEW.id, NEW.file_path, COALESCE(NEW.metadata, ''), NEW.content);
    END;
  `);

  const backfill = db.prepare(`
    INSERT INTO code_chunks_fts (chunk_id, file_path, metadata, content)
    SELECT c.id, c.file_path, COALESCE(c.metadata, ''), c.content
      FROM code_chunks c
     WHERE NOT EXISTS (
       SELECT 1 FROM code_chunks_fts f WHERE f.chunk_id = c.id
     )
  `);

  db.transaction(() => backfill.run())();
}

/**
 * Converts natural-language input into a safe FTS5 expression.
 *
 * Only alphanumeric identifier fragments are quoted into the expression; the
 * caller's punctuation is never interpreted as FTS syntax.
 *
 * @param query - The request supplied to semantic search.
 * @returns An OR expression, or `undefined` when no searchable terms remain.
 */
export function toLexicalMatchExpression(query: string): string | undefined {
  const terms = query
    .match(/[\p{L}\p{N}_]+/gu)
    ?.map((term) => term.toLocaleLowerCase())
    .filter((term) => term.length >= 2)
    .filter((term, index, all) => all.indexOf(term) === index)
    .slice(0, MAX_QUERY_TERMS);

  if (terms === undefined || terms.length === 0) return undefined;

  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR ');
}

/**
 * Checks whether a lexical result directly names a requested identifier in its
 * path or metadata. Content-only matches remain useful candidates, but do not
 * independently establish grounded evidence.
 *
 * @param query - Original user query.
 * @param filePath - Candidate repository-relative path.
 * @param metadata - Candidate chunk metadata JSON.
 * @returns Whether the candidate has direct path or symbol evidence.
 */
export function hasExactLexicalEvidence(
  query: string,
  filePath: string,
  metadata: string,
): boolean {
  const queryTerms = query
    .match(/[\p{L}\p{N}_]+/gu)
    ?.map((term) => term.toLocaleLowerCase())
    .filter((term) => term.length >= 3)
    .filter((term, index, all) => all.indexOf(term) === index);

  if (queryTerms === undefined || queryTerms.length === 0) return false;

  const evidenceTerms = new Set(
    `${filePath} ${metadata}`
      .match(/[\p{L}\p{N}_]+/gu)
      ?.map((term) => term.toLocaleLowerCase()) ?? [],
  );

  return queryTerms.some((term) => evidenceTerms.has(term));
}

/**
 * Searches the local FTS5 index without allowing query text to become SQL or
 * FTS syntax. BM25 is used only to order lexical candidates; it is never
 * compared with an embedding similarity score.
 *
 * @param db - SQLite connection that owns the FTS table.
 * @param query - Natural-language request.
 * @param limit - Maximum lexical candidates.
 * @returns Candidate chunk ids in lexical rank order.
 */
export function findLexicalCandidates(
  db: Database.Database,
  query: string,
  limit: number,
): readonly LexicalCandidate[] {
  const expression = toLexicalMatchExpression(query);
  if (expression === undefined) return [];

  const rows = db
    .prepare(
      `SELECT chunk_id AS chunkId,
              bm25(code_chunks_fts, 8.0, 5.0, 1.0) AS rank
         FROM code_chunks_fts
        WHERE code_chunks_fts MATCH ?
        ORDER BY rank
        LIMIT ?`,
    )
    .all(expression, limit) as { chunkId: string; rank: number }[];

  return rows;
}
