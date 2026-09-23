/**
 * @module UnknownTerms
 *
 * Detects a query term the repository has never contained, which is the
 * cheapest and most direct evidence that a question is about something the
 * repository does not have.
 *
 * ## The measured failure this answers
 *
 * ADR-028 grounds an answer when a candidate appears in both the semantic and
 * the lexical ranking, or when `hasExactLexicalEvidence` finds *any* query term
 * in a candidate's path or metadata. Measured on 2026-09-08, that policy
 * returned source for **all ten** nonexistent-feature cases, on both providers
 * identically. A question of the form *"where does Umbra expose a <product>
 * metrics endpoint?"*, naming a monitoring product this repository has no
 * integration with, answered with `src/core/rag/retrieval-metrics.ts`.
 *
 * `metrics` is in that filename, so a single common word carried the whole
 * grounding decision. The word that made the question specific — the product
 * name — was never required to match anything, and matches nothing anywhere in
 * the repository.
 *
 * ## A hazard this module creates for its own tests
 *
 * The benchmark corpus proves this rule with questions about technologies the
 * repository does not use. Naming one of those technologies **in indexed
 * source** makes the repository contain it, and the corresponding corpus case
 * silently stops being a negative. That is not hypothetical: the first version
 * of this file named a real corpus term in this very comment, and the case it
 * described was the one negative that still failed the next benchmark run.
 * Describe the shape of such a question here; never write the word.
 *
 * Rank agreement tests whether two retrievers are *consistent*. It does not
 * test whether either of them is *about the question*. Two retrievers agree
 * readily about a document that shares only filler with the query.
 *
 * ## Why this rule and not a score threshold
 *
 * ADR-028 set its own criterion: the policy must rely on independent evidence
 * rather than "a raw threshold fitted to one repository". A term's presence or
 * absence in the index is a property the index answers about itself. There is
 * no constant to tune, nothing to re-fit per repository, and the rule states
 * something a person would accept without arithmetic: *if this codebase has
 * never once written the name of a message broker, it does not integrate with
 * that broker.*
 *
 * ## What is deliberately not done
 *
 * No synonyms and no fuzzy matching. Inflection is handled, and only barely —
 * see {@link termProbes} — because a near-miss on morphology is a false
 * abstention caused by grammar rather than by subject. Everything beyond that
 * is left out, and the cost is measured rather than assumed: the false
 * abstention rate is exactly what the calibration corpus reports. Measured on
 * 2026-09-08 it is 2.2%, one case in forty-five, against a correct abstention
 * rate that went from 0% to 90%.
 */

import type Database from 'better-sqlite3';

/**
 * English function words, excluded because they carry grammar rather than
 * subject.
 *
 * This is a closed list of English structure, not a list fitted to this
 * repository — which is the distinction that keeps the rule portable. It
 * matters because most of these words *do* appear somewhere in a commented
 * TypeScript corpus, so leaving them in would make the rule accidentally
 * dependent on how heavily a project comments its code.
 */
const FUNCTION_WORDS = new Set([
  'about', 'after', 'also', 'and', 'any', 'are', 'been', 'before', 'being',
  'between', 'both', 'but', 'can', 'does', 'doing', 'done', 'during', 'each',
  'for', 'from', 'has', 'have', 'here', 'how', 'into', 'its', 'just', 'like',
  'made', 'make', 'many', 'more', 'most', 'much', 'must', 'not', 'now', 'only',
  'other', 'our', 'out', 'over', 'own', 'same', 'should', 'since', 'some',
  'such', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these',
  'they', 'this', 'those', 'through', 'thus', 'under', 'until', 'very', 'was',
  'were', 'what', 'when', 'where', 'which', 'while', 'who', 'why', 'will',
  'with', 'would', 'you', 'your',
]);

/** Shortest term considered subject-bearing. */
const MIN_TERM_LENGTH = 4;

/**
 * English inflectional endings, longest first.
 *
 * A term is only declared unknown when neither it nor its stem appears. Without
 * this the rule abstains on morphology rather than on subject: *"Where is
 * retrieval **handled**?"* would be refused by a repository whose code says
 * `handle`, which is a false abstention caused by grammar and would make the
 * rule worse than the policy it replaces.
 *
 * Deliberately a short list of inflection, not a stemmer. Porter stemming would
 * be more thorough and would require changing the FTS5 tokenizer, rebuilding
 * the index, and accepting its aggressive truncation on identifiers — a much
 * larger change for the cases beyond these endings, which are rare in the
 * questions people actually ask about code.
 */
const INFLECTIONS = ['ing', 'ed', 'es', 's'];

/**
 * Builds the FTS5 expressions that decide whether the index knows a term.
 *
 * The exact term is always probed. When it carries an inflectional ending, its
 * stem is probed as a **prefix** as well.
 *
 * The prefix is what makes this work in both directions. Stemming only the
 * query fails whenever the code holds a different inflection of the same word:
 * *"where is the query **defined**?"* against source that says `defines` would
 * abstain, having reduced the question to `defin` and found no such token.
 * `defin*` matches `define`, `defines`, `defined` and `defining` in one probe,
 * which is the property a real stemmer would provide on both sides.
 *
 * A full Porter tokenizer would be more thorough. It would also mean changing
 * the FTS5 tokenizer, rebuilding the index, and accepting Porter's aggressive
 * truncation of identifiers — a much larger change than the cases beyond these
 * four endings justify.
 *
 * ## The one spelling change inflection makes
 *
 * English writes a final consonant-plus-`y` as `i` before `-es` and `-ed`:
 * `apply`, `applies`, `applied`. Stripping an ending cannot see that, so without
 * {@link alternationRoot} the rule abstained on it in both directions — a
 * question saying **apply** against source that says only `applied`, and one
 * saying **applies** against source that says only `apply`. Measured on the
 * gate fixture on 2026-09-23, this was one of its two false abstentions.
 *
 * The examples are deliberately not corpus questions. An earlier draft of this
 * comment paraphrased one, and the live benchmark ranked this file above the
 * case's expected answer — the hazard the module header describes, reached
 * through a positive instead of a negative.
 *
 * @param term - A lowercased subject term.
 * @returns One to three FTS5 match expressions.
 */
export function termProbes(term: string): readonly string[] {
  const quoted = `"${term.replaceAll('"', '""')}"`;
  const prefix = (stem: string): string => `"${stem.replaceAll('"', '""')}"*`;

  for (const ending of INFLECTIONS) {
    if (!term.endsWith(ending)) continue;
    const stem = term.slice(0, -ending.length);
    // Guard against a stem so short it matches most of the repository:
    // `uses` -> `use*` is fine, `is` -> `i*` would make the rule meaningless.
    if (stem.length < MIN_TERM_LENGTH - 1) continue;

    const root = alternationRoot(stem, true);
    return root === undefined ? [quoted, prefix(stem)] : [quoted, prefix(stem), prefix(root)];
  }

  const root = alternationRoot(term, false);
  return root === undefined ? [quoted] : [quoted, prefix(root)];
}

/**
 * Removes the letter that alternates between `y` and `i` under inflection, so
 * one prefix reaches every spelling: `appl*` matches `apply`, `applies`,
 * `applied` and `applying`.
 *
 * Only after a consonant — `deploy` keeps its `y` in `deployed`, so there is
 * nothing to reach. An `i` is removed only from a stem that lost an ending,
 * because a base word ending in `i` did not come from a `y`.
 *
 * The root must be a full term long. A three-letter consonant-final prefix is
 * promiscuous — `deny` would probe `den*` and find `dense` — and a term found by
 * accident fails towards answering, which is the failure this module exists to
 * prevent. Those short words keep the exact probe they had before.
 *
 * @param stem - A lowercased term, or a term with its ending removed.
 * @param inflected - Whether an inflectional ending was removed.
 * @returns The root to probe as a prefix, or `undefined` when none applies.
 */
function alternationRoot(stem: string, inflected: boolean): string | undefined {
  const alternating = inflected ? /[^aeiou][yi]$/ : /[^aeiou]y$/;
  if (!alternating.test(stem)) return undefined;
  const root = stem.slice(0, -1);
  return root.length >= MIN_TERM_LENGTH ? root : undefined;
}

/** Terms examined per query, matching the lexical index's own cap. */
const MAX_TERMS = 12;

/** Separates absent subjects from an absent repeated manner modifier such as `byte by byte`. */
export interface UnknownTermAssessment {
  /** Terms that still make the question unsupported by indexed evidence. */
  readonly strict: readonly string[];
  /** Repeated manner modifiers omitted from the absence gate, never from retrieval. */
  readonly ignoredModifiers: readonly string[];
  /**
   * Unknown subject terms retrieval went on without. Always empty since 2.3.0:
   * dropping one whenever another subject was grounded answered every
   * nonexistent-feature case (see {@link assessUnknownTerms}). Kept because the
   * MCP output schema publishes it.
   */
  readonly droppedTerms: readonly string[];
}

/**
 * Extracts the subject-bearing terms of a query.
 *
 * @param query - The natural-language request.
 * @returns Lowercased, de-duplicated terms, capped.
 */
export function subjectTerms(query: string): readonly string[] {
  return (
    query
      .match(/[\p{L}\p{N}_]+/gu)
      ?.map((term) => term.toLocaleLowerCase())
      .filter((term) => term.length >= MIN_TERM_LENGTH)
      .filter((term) => !FUNCTION_WORDS.has(term))
      .filter((term, index, all) => all.indexOf(term) === index)
      .slice(0, MAX_TERMS) ?? []
  );
}

/**
 * Returns the query's subject terms that appear nowhere in the index.
 *
 * Each term is asked of FTS5 individually. A term that returns no row has
 * never been written in this repository's indexed source — not in a path, not
 * in metadata, not in a comment.
 *
 * @param db - The connection owning `code_chunks_fts`.
 * @param query - The natural-language request.
 * @param exempt - Terms an operator has explicitly taught, which are known by
 *        definition even though the source never contains them (ADR-029).
 * @returns The unknown terms, in query order. Empty when every term is known.
 */
export function findUnknownTerms(
  db: Database.Database,
  query: string,
  exempt: ReadonlySet<string> = new Set(),
): readonly string[] {
  const terms = subjectTerms(query).filter((term) => !exempt.has(term));
  if (terms.length === 0) return [];

  const probe = db.prepare(
    `SELECT 1 FROM code_chunks_fts WHERE code_chunks_fts MATCH ? LIMIT 1`,
  );

  const matches = (expression: string): boolean => {
    // A malformed expression must not take down retrieval; an unanswerable
    // probe is treated as a match, which fails towards answering rather than
    // towards silence.
    try {
      return probe.get(expression) !== undefined;
    } catch {
      return true;
    }
  };

  return terms.filter((term) => !termProbes(term).some(matches));
}

/**
 * Classifies unknown terms without turning an arbitrary missing word into a soft match.
 *
 * A repeated phrase of the form `X by X` describes the requested granularity,
 * not necessarily a repository feature. It is safely omitted only when at
 * least two other subject terms are grounded. The original query is still sent
 * to hybrid retrieval; this only prevents the pre-query absence gate from
 * refusing a question because of an idiom.
 *
 * ## Why a grounded subject does not excuse an unknown one
 *
 * From 2026-09-18 to 2026-09-23 it did: an unknown term was moved to
 * `droppedTerms` whenever any other subject was known, and retrieval went on.
 * That answered the two false abstentions on the gate fixture, and it answered
 * all ten nonexistent-feature cases as well — correct abstention fell from 1 to
 * 0, and `@dastbal/umbra@2.2.11` shipped with it. A question about a missing
 * integration almost always pairs the missing name with grounded words —
 * *"where does Umbra expose a <product> metrics endpoint?"* — so "another
 * subject is known" is true of nearly every negative, and the grounding check
 * that runs next is the one ADR-028 measured answering all of them.
 *
 * The index cannot tell a word the code spells differently from a feature the
 * code does not have: both are absent. What it can do is stop missing words it
 * does contain, which is what {@link termProbes} fixed for one of those two
 * false abstentions. For the other, the vocabulary gap is real, and teaching the
 * alias with `/learn-search` (ADR-029) is the remedy that does not reopen the
 * gate. `droppedTerms` stays in the contract, empty, because the MCP output
 * schema publishes it.
 *
 * @param db - The connection owning `code_chunks_fts`.
 * @param query - Original user wording, preserved for retrieval.
 * @param exempt - Locally approved aliases that are known by definition.
 * @returns Strict unknown subjects and any explicitly degraded modifiers.
 */
export function assessUnknownTerms(
  db: Database.Database,
  query: string,
  exempt: ReadonlySet<string> = new Set(),
): UnknownTermAssessment {
  const unknown = findUnknownTerms(db, query, exempt);
  const terms = subjectTerms(query).filter((term) => !exempt.has(term));
  const knownSubjectCount = terms.filter((term) => !unknown.includes(term)).length;
  const repeated = repeatedMannerTerms(query);
  const ignoredModifiers = knownSubjectCount >= 2
    ? unknown.filter((term) => repeated.has(term))
    : [];
  return {
    strict: unknown.filter((term) => !ignoredModifiers.includes(term)),
    ignoredModifiers,
    droppedTerms: [],
  };
}

/** Finds `byte by byte`-shaped modifiers without classifying arbitrary unknown words as optional. */
function repeatedMannerTerms(query: string): ReadonlySet<string> {
  const modifiers = new Set<string>();
  const pattern = /\b([\p{L}\p{N}_]{4,})\s+by\s+\1\b/giu;
  for (const match of query.matchAll(pattern)) {
    const term = match[1]?.toLocaleLowerCase();
    if (term !== undefined) modifiers.add(term);
  }
  return modifiers;
}

/**
 * Builds the abstention report for a question naming something absent.
 *
 * Naming the unrecognised term is the whole value of this path: "no grounded
 * evidence" leaves the reader unsure whether the repository lacks the feature
 * or the retriever failed. "This repository never mentions `kafka`" is a fact
 * they can act on.
 *
 * @param query - The original request, echoed back for context.
 * @param unknown - Terms the index does not contain.
 * @returns The report text.
 */
export function unknownTermReport(query: string, unknown: readonly string[]): string {
  const named = unknown.map((term) => `\`${term}\``).join(', ');
  return [
    '🚫 **NO GROUNDED EVIDENCE**',
    '',
    `The question mentions ${named}, and this repository's indexed source contains`,
    'no occurrence of it — not in a file path, a symbol name, or a comment.',
    '',
    'Umbra is not withholding a weak match: there is nothing to match. Treat this',
    'as evidence the feature is absent rather than as a retrieval failure.',
    '',
    `Question: ${query}`,
  ].join('\n');
}
