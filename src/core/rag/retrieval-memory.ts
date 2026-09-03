import Database from 'better-sqlite3';
import { AgentDB } from '../state/db';

/** A confirmed, local mapping from a user's wording to code-backed context. */
export interface RetrievalAlias {
  readonly triggerTerms: readonly string[];
  readonly contextTerms: readonly string[];
  readonly verifiedPaths: readonly string[];
}

/** A candidate that exists only in process memory until the CLI approves it. */
export interface PendingRetrievalAlias extends RetrievalAlias {}

const MAX_ALIASES = 200;
const NOISE_TERMS = new Set([
  'a', 'al', 'and', 'con', 'de', 'del', 'el', 'en', 'es', 'la', 'las', 'lo', 'los',
  'me', 'mi', 'no', 'para', 'please', 'por', 'que', 'si', 'the', 'un', 'una', 'y',
  'bello', 'dale', 'gracias', 'hola', 'podes', 'puede', 'quiero', 'buscar', 'busca',
  'buscame', 'favor',
]);

let pendingAlias: PendingRetrievalAlias | undefined;

/**
 * Normalizes user wording into identifiers useful for retrieval. It deliberately
 * drops conversational filler, so an operator's manner of speaking never
 * becomes a project alias.
 *
 * @param text - User wording or clarification.
 * @returns Unique searchable terms in their first-seen order.
 */
export function normalizeRetrievalTerms(text: string): readonly string[] {
  const terms: string[] = [...(text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase()
    .match(/[\p{L}\p{N}_]+/gu) ?? [])];

  return terms.filter(
    (term, index) => term.length >= 3 && !NOISE_TERMS.has(term) && terms.indexOf(term) === index,
  );
}

/** Creates the local table used only for approved retrieval vocabulary. */
export function ensureRetrievalMemory(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS retrieval_aliases (
      id INTEGER PRIMARY KEY,
      trigger_terms TEXT NOT NULL,
      context_terms TEXT NOT NULL,
      verified_paths TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL,
      use_count INTEGER NOT NULL DEFAULT 0
    );
  `);
}

/**
 * Owns project-local aliases while keeping all code evidence in `code_chunks`.
 */
export class RetrievalMemoryService {
  /** @param db - Local Umbra database, injectable for deterministic tests. */
  constructor(private readonly db: Database.Database = AgentDB.getInstance()) {
    ensureRetrievalMemory(this.db);
  }

  /**
   * Adds approved, code-backed context to a new query. No raw prompt is read
   * from storage; aliases are matching normalized terms only.
   *
   * @param query - The user's current wording.
   * @returns A bounded canonical query for FTS and embeddings.
   */
  public expand(query: string): string {
    const terms = [...normalizeRetrievalTerms(query)];
    if (terms.length === 0) return query;

    const rows = this.db.prepare(
      `SELECT id, trigger_terms, context_terms FROM retrieval_aliases ORDER BY last_used_at DESC`,
    ).all() as { id: number; trigger_terms: string; context_terms: string }[];
    const additions = new Set<string>();
    for (const row of rows) {
      const triggers = parseTerms(row.trigger_terms);
      if (!triggers.some((term) => terms.includes(term))) continue;
      for (const term of parseTerms(row.context_terms)) {
        if (terms.length + additions.size >= 18) break;
        if (!terms.includes(term)) additions.add(term);
      }
    }

    return [...terms, ...additions].join(' ');
  }

  /** Persists one alias only after an explicit operator action. */
  public approve(alias: RetrievalAlias): boolean {
    const triggerTerms = normalizeAliasTerms(alias.triggerTerms);
    const contextTerms = normalizeAliasTerms(alias.contextTerms);
    const verifiedPaths = [...new Set(alias.verifiedPaths)].slice(0, 4);
    if (triggerTerms.length === 0 || contextTerms.length === 0 || verifiedPaths.length === 0) {
      return false;
    }

    const now = Date.now();
    this.db.transaction(() => {
      const count = (this.db.prepare(`SELECT COUNT(*) AS count FROM retrieval_aliases`).get() as {
        count: number;
      }).count;
      if (count >= MAX_ALIASES) {
        this.db.prepare(
          `DELETE FROM retrieval_aliases WHERE id IN (
             SELECT id FROM retrieval_aliases ORDER BY last_used_at ASC, id ASC LIMIT 1
           )`,
        ).run();
      }
      this.db.prepare(
        `INSERT INTO retrieval_aliases
           (trigger_terms, context_terms, verified_paths, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(JSON.stringify(triggerTerms), JSON.stringify(contextTerms), JSON.stringify(verifiedPaths), now, now);
    })();
    return true;
  }
}

/** Stages a candidate until the operator explicitly invokes `/learn-search`. */
export function stageRetrievalAlias(alias: PendingRetrievalAlias): void {
  pendingAlias = alias;
}

/** Returns whether this process has a contextual result waiting for approval. */
export function hasPendingRetrievalAlias(): boolean {
  return pendingAlias !== undefined;
}

/** Commits and clears the staged alias. It is intentionally CLI-invoked only. */
export function approvePendingRetrievalAlias(): boolean {
  if (pendingAlias === undefined) return false;
  const approved = new RetrievalMemoryService().approve(pendingAlias);
  if (approved) pendingAlias = undefined;
  return approved;
}

/** Clears an unapproved candidate, primarily for deterministic tests. */
export function clearPendingRetrievalAlias(): void {
  pendingAlias = undefined;
}

function parseTerms(value: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((term) => typeof term === 'string')
      ? parsed
      : [];
  } catch {
    return [];
  }
}

function normalizeAliasTerms(terms: readonly string[]): readonly string[] {
  return [...new Set(terms.flatMap((term) => normalizeRetrievalTerms(term)))].slice(0, 12);
}
