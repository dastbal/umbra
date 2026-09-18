/**
 * Renders a stored file skeleton for injection into RAG context.
 *
 * `RetrieverService` used to interpolate `file_registry.skeleton_signature`
 * straight into the answer, which meant the model received the JSON exactly as
 * SQLite stored it — braces, quoted keys, escaped newlines and every import
 * statement in full. Measured across this repository's 169 stored skeletons,
 * 43.3% of those tokens were the JSON envelope and 14.2% were external package
 * import statements; on a consumer repository importing a sixty-name SDK list
 * the block reached 65% of one answer.
 *
 * Three lines above that block the retriever already renders the graph-derived
 * import list capped at five entries and filtered to first-party paths. One
 * function, two lists, opposite discipline — which is what marks the uncapped
 * one as an omission rather than a design (ADR-011's 2026-09-10 amendment).
 *
 * ## Why specifiers instead of statements
 *
 * A skeleton is a map. What a map owes the reader is *what this file depends
 * on*, not *which names it pulled from each dependency* — and the named
 * bindings are already in the answer twice over: the `DEPENDENCIES` block lists
 * first-party imports resolved through the dependency graph. Class-signature
 * chunks deliberately no longer repeat import declarations, because a full
 * import list can outweigh the class behaviour it was meant to contextualize.
 *
 * This renders module specifiers, split by whether they are first-party, and
 * capped the same way the sibling list is. The class and method signatures are
 * **not** capped: they are the structure the block exists to carry, and a
 * bound on them is a separate decision with a real cost.
 *
 * ## What this deliberately does not touch
 *
 * `NestChunker#generateSkeleton` still stores exactly what it stored before.
 * ADR-011 froze that shape for blast radius — it is persisted per indexed file
 * and changing it forces a reindex — and the freeze covers what is *stored*,
 * not what is *rendered*. This module is the rendering.
 */

/** How many specifiers to list per group before summarising the remainder. */
const MAX_LISTED_SPECIFIERS = 8;

/**
 * The shape `NestChunker#generateSkeleton` persists.
 *
 * Atomic files — DTOs, entities, interfaces, enums — carry `{ type: 'full' }`
 * instead of a signature list, because for them the whole file *is* the
 * structure. `analyzeCodeStructureTool` substitutes the file content in that
 * case; the retriever has no file content here and says so instead.
 */
export interface StoredSkeleton {
  type?: string;
  imports?: string[];
  classes?: Array<{ name?: string; methods?: string[] }>;
}

/**
 * Extracts the module specifier from an import declaration's full text.
 *
 * @param statement - One import statement as `ts-morph` printed it.
 * @returns The quoted specifier, or `undefined` when the text is not an import
 * this can read — in which case the caller keeps counting it but cannot name it.
 */
export function importSpecifierOf(statement: string): string | undefined {
  const fromClause = /\bfrom\s+['"]([^'"]+)['"]/.exec(statement);
  if (fromClause !== null) return fromClause[1];

  // Side-effect imports (`import './polyfill';`) and bare module requires have
  // no `from` clause but still name a dependency.
  const bare = /^\s*import\s+['"]([^'"]+)['"]/.exec(statement);
  return bare === null ? undefined : bare[1];
}

/**
 * Reports whether a specifier points inside the project.
 *
 * The same rule `NestChunker#extractDependencies` already applies when deciding
 * what becomes a `dependency_graph` edge, kept identical on purpose: a reader
 * comparing the two lists in one answer should not have to wonder whether
 * "first-party" means the same thing in both.
 *
 * @param specifier - A module specifier.
 * @returns `true` for a relative specifier.
 */
export function isFirstPartySpecifier(specifier: string): boolean {
  return specifier.startsWith('.');
}

/** Renders one capped, comma-separated group, or nothing when it is empty. */
function renderGroup(label: string, specifiers: readonly string[]): string | undefined {
  if (specifiers.length === 0) return undefined;

  const listed = specifiers.slice(0, MAX_LISTED_SPECIFIERS).join(', ');
  const remainder = specifiers.length - MAX_LISTED_SPECIFIERS;
  return remainder > 0
    ? `${label}: ${listed} (...and ${remainder} more)`
    : `${label}: ${listed}`;
}

/**
 * Renders the stored skeleton as text, or reports that there is nothing to show.
 *
 * `null` is accepted because that is what the column actually yields: the
 * registry stores a row before a skeleton exists for it, so
 * `RetrieverService#getFileSkeleton` returns SQLite's `NULL` even though it was
 * declared `string | undefined`. The previous truthiness check hid that; a
 * strict `=== undefined` did not, and the quality gate caught it immediately.
 *
 * @param stored - The raw `file_registry.skeleton_signature` column, which is
 * JSON when it is present at all, and `null` when the file has no skeleton yet.
 * @returns The rendering, or `undefined` when the caller should omit the block
 * entirely rather than print an empty heading.
 */
export function renderSkeletonForContext(
  stored: string | null | undefined,
): string | undefined {
  if (stored === undefined || stored === null || stored.trim().length === 0) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    // The column is always written through `JSON.stringify`, so unparsable
    // means corrupt. Emitting the raw text would put the malformed payload in
    // front of the model, which is what this module exists to stop.
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const skeleton = parsed as StoredSkeleton;

  // An atomic file's chunk is the whole file, so the snippet below already
  // carries the structure and the closing hint already names `read_file`. A
  // marker line here is the one case where the block can only repeat itself,
  // and rendering the marker as prose measured 8 tokens *worse* than the raw
  // `{"type":"full"}` it replaced.
  if (skeleton.type === 'full') return undefined;

  const sections: string[] = [];

  for (const declared of skeleton.classes ?? []) {
    const methods = declared.methods ?? [];
    const rendered = methods.length === 0
      ? '  (no methods)'
      : methods.map((method) => `  - ${method}`).join('\n');
    sections.push(`CLASS ${declared.name ?? '(anonymous)'}:\n${rendered}`);
  }

  const firstParty: string[] = [];
  const external: string[] = [];
  let unreadable = 0;
  for (const statement of skeleton.imports ?? []) {
    const specifier = importSpecifierOf(statement);
    if (specifier === undefined) {
      unreadable += 1;
      continue;
    }
    const group = isFirstPartySpecifier(specifier) ? firstParty : external;
    if (!group.includes(specifier)) group.push(specifier);
  }

  const imports = [
    renderGroup('IMPORTS', firstParty),
    renderGroup('PACKAGES', external),
    unreadable > 0 ? `(${unreadable} import statement(s) could not be read)` : undefined,
  ].filter((line): line is string => line !== undefined);

  if (imports.length > 0) sections.push(imports.join('\n'));

  return sections.length === 0 ? undefined : sections.join('\n\n');
}
