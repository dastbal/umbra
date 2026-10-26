import Database from 'better-sqlite3';

/** A lexical candidate returned by the local FTS index. */
export interface LexicalCandidate {
  readonly chunkId: string;
  readonly rank: number;
}

const MAX_QUERY_TERMS = 12;

/** TypeScript syntax words that occur in most source files but name no subject. */
const TYPESCRIPT_SYNTAX_FILLERS = new Set([
  'import', 'imports', 'export', 'exports', 'class', 'classes', 'type', 'types',
  'interface', 'interfaces', 'default',
]);

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
  const terms = lexicalTerms(query, 2).slice(0, MAX_QUERY_TERMS);

  if (terms.length === 0) return undefined;

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
  const queryTerms = lexicalTerms(query, 3);

  if (queryTerms.length === 0) return false;

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
      // One weight per column, including the UNINDEXED one, because that is how
      // FTS5 assigns them: positionally, from column 0, with any missing
      // trailing weight defaulting to 1.0. This used to read
      // `bm25(code_chunks_fts, 8.0, 5.0, 1.0)`, which looks like three weights
      // for the three indexed columns and is not — it landed 8.0 on `chunk_id`,
      // where an unindexed column contributes nothing whatever its weight, 5.0
      // on `file_path`, 1.0 on `metadata`, and the 1.0 default on `content`.
      //
      // The form below is **behaviourally identical** to that call, verified
      // both on the calibration corpus and on a raw 40-row ordering. It is
      // written out so nobody has to re-derive the offset to read the line.
      //
      // Do not "fix" it to `(0.0, 8.0, 5.0, 1.0)`. That is what the old call
      // appeared to intend, and measured on the live calibration split through
      // the control arm it is a regression: Hit@4 0.689 -> 0.644 and MRR
      // 0.607 -> 0.537. Boosting `metadata` actively hurts, and the accident
      // was better than the intent. `(0.0, 8.0, 1.0, 1.0)` measured marginally
      // best at MRR 0.619, which is inside this corpus's resolution — one case
      // is 2.2 points — so it is not a defensible change on that evidence.
      //
      // **CI will not stop that change.** Measured the same day: the fixture
      // gate reports MRR 0.667 for those weights against 0.656 for these, so it
      // calls the live regression a small improvement. The fixture holds 158
      // chunks against ~1,000 and 15 positives against 45, and here it disagrees
      // with the live corpus about the *direction* of a change rather than only
      // its size — a sharper limit than ADR-031's warning that its numbers are
      // not the live numbers. Re-weighting BM25 has to be measured with
      // `npm run bench:fts-only`, which isolates lexical ranking with no
      // embedding, and a green gate is not evidence either way.
      `SELECT chunk_id AS chunkId,
              bm25(code_chunks_fts, 0.0, 5.0, 1.0, 1.0) AS rank
         FROM code_chunks_fts
        WHERE code_chunks_fts MATCH ?
        ORDER BY rank
        LIMIT ?`,
    )
    .all(expression, limit) as { chunkId: string; rank: number }[];

  return rows;
}

/**
 * Keeps TypeScript syntax searchable when it is the whole question, but strips
 * it when concrete terms are available to identify what the operator means.
 *
 * @param query - Operator wording to normalize for lexical retrieval.
 * @param minimumLength - Shortest useful term for the consuming FTS operation.
 * @returns Distinct subject terms, or syntax terms when no subject was supplied.
 */
function lexicalTerms(query: string, minimumLength: number): string[] {
  const terms = query
    .match(/[\p{L}\p{N}_]+/gu)
    ?.map((term) => term.toLocaleLowerCase())
    .filter((term) => term.length >= minimumLength)
    .filter((term, index, all) => all.indexOf(term) === index) ?? [];
  const subjects = terms.filter((term) => !TYPESCRIPT_SYNTAX_FILLERS.has(term));
  return subjects.length > 0 ? subjects : terms;
}
