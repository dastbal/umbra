import * as fs from 'fs';
import * as path from 'path';
import { agentPath } from '../config/agent-directory';
import { WorkspaceDiscoveryService } from '../config/workspace-discovery';

const CACHE_VERSION = 2;
const ADR_FILE_PATTERN = /^(ADR[-_]\d{3,})[-_].+\.md$/i;
const MAX_CONTEXT_LENGTH = 220;

/** A compact, project-relative description of one Architecture Decision Record. */
export interface AdrIndexEntry {
  /** Stable ADR identifier parsed from its filename. */
  id: string;
  /** Module/catalog that owns this decision record. */
  module: string;
  /** ADR path relative to the project root, normalized with `/`. */
  path: string;
  /** Title from the document H1 without its ADR identifier. */
  title: string;
  /** First paragraph of the Estado section. */
  statusLabel: string;
  /** First paragraph of the Contexto section, bounded for prompt safety. */
  context: string;
  /** File size used to invalidate the local cache. */
  size: number;
  /** File modification time used to invalidate the local cache. */
  mtimeMs: number;
}

/** Local ADR catalog returned to the agent without loading full decision records. */
export interface AdrIndex {
  /** Whether this call rebuilt metadata or reused the local cache. */
  status: 'cached' | 'rebuilt';
  /** ISO timestamp from the latest catalog build. */
  generatedAt: string;
  /** ADR metadata ordered by identifier. */
  entries: AdrIndexEntry[];
}

interface AdrIndexCache {
  version: number;
  generatedAt: string;
  entries: AdrIndexEntry[];
}

interface AdrCandidate {
  id: string;
  module: string;
  path: string;
  absolutePath: string;
  size: number;
  mtimeMs: number;
  curated?: Pick<AdrIndexEntry, 'title' | 'statusLabel' | 'context'>;
}

/**
 * Builds or reuses a local catalog of Architecture Decision Records.
 *
 * The catalog contains only the decision identifier, title, status, and a
 * bounded context paragraph. It is written to `.umbra/adr-index.json` so an
 * agent can select one relevant ADR without loading the entire history.
 *
 * @param rootDir - Project root containing `docs/adr`.
 * @param refresh - Rebuild metadata even when the cache is current.
 * @returns Compact ADR metadata suitable for a tool response.
 */
export function buildAdrIndex(rootDir: string, refresh = false): AdrIndex {
  const resolvedRoot = path.resolve(rootDir);
  const candidates = discoverAdrs(resolvedRoot);
  const cachePath = agentPath(resolvedRoot, 'adr-index.json');
  const cache = refresh ? undefined : readCache(cachePath);

  if (cache !== undefined && matchesCandidates(cache.entries, candidates)) {
    return {
      status: 'cached',
      generatedAt: cache.generatedAt,
      entries: cache.entries,
    };
  }

  const entries = candidates.map((candidate) => ({
    ...candidate,
    ...(candidate.curated ?? readAdrMetadata(candidate.absolutePath, candidate.id)),
  })).map(({ absolutePath: _absolutePath, curated: _curated, ...entry }) => entry);
  const generatedAt = new Date().toISOString();
  const nextCache: AdrIndexCache = {
    version: CACHE_VERSION,
    generatedAt,
    entries,
  };

  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, `${JSON.stringify(nextCache, null, 2)}\n`, 'utf8');

  return { status: 'rebuilt', generatedAt, entries };
}

/**
 * Converts the ADR catalog into a small tool response.
 *
 * @param index - Catalog from {@link buildAdrIndex}.
 * @returns A path-and-metadata list without full ADR bodies.
 */
export function formatAdrIndex(index: AdrIndex): string {
  return formatAdrIndexForModule(index);
}

/** Formats the complete catalog or one requested module. */
export function formatAdrIndexForModule(index: AdrIndex, module?: string): string {
  const entries = module === undefined
    ? index.entries
    : index.entries.filter((entry) => entry.module === module);
  if (module !== undefined && entries.length === 0) {
    const available = [...new Set(index.entries.map((entry) => entry.module))].sort();
    return `❌ ADR module "${module}" was not found. Available modules: ${available.join(', ') || '(none)'}.`;
  }
  if (entries.length === 0) {
    return 'ADR catalog: no decision records were discovered.';
  }

  const lines = entries.map((entry) =>
    `- [${entry.module}] ${entry.id} — ${entry.title} [${entry.statusLabel}]; context: ${entry.context}`,
  );

  return `ADR catalog (${index.status}; ${entries.length} decisions):\n${lines.join('\n')}`;
}

function discoverAdrs(rootDir: string): AdrCandidate[] {
  const candidates: AdrCandidate[] = [];
  for (const catalog of new WorkspaceDiscoveryService(rootDir).discoverAdrCatalogs()) {
    const curated = catalog.readmePath === undefined ? new Map<string, Pick<AdrIndexEntry, 'title' | 'statusLabel' | 'context'>>() : readCuratedCatalog(path.join(rootDir, catalog.readmePath));
    for (const entry of fs.readdirSync(catalog.absolutePath, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const match = ADR_FILE_PATTERN.exec(entry.name);
      if (match === null) continue;
      const absolutePath = path.resolve(catalog.absolutePath, entry.name);
      const stat = fs.statSync(absolutePath);
      candidates.push({
        id: match[1].replace('_', '-').toUpperCase(),
        module: catalog.module,
        path: path.relative(rootDir, absolutePath).split(path.sep).join('/'),
        absolutePath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        curated: curated.get(entry.name),
      });
    }
  }

  return candidates.sort((left, right) => left.module.localeCompare(right.module) || left.id.localeCompare(right.id));
}

/** Reads the human-maintained index row for each linked ADR, when a catalog supplies one. */
function readCuratedCatalog(readmePath: string): Map<string, Pick<AdrIndexEntry, 'title' | 'statusLabel' | 'context'>> {
  const metadata = new Map<string, Pick<AdrIndexEntry, 'title' | 'statusLabel' | 'context'>>();
  for (const line of fs.readFileSync(readmePath, 'utf8').split(/\r?\n/)) {
    if (!line.startsWith('|') || !/\]\(([^)]+)\)/.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    const link = /\]\(([^)]+)\)/.exec(cells[0] ?? '')?.[1];
    if (link === undefined) continue;
    const fileName = path.basename(link);
    const title = (cells[1] ?? '').replace(/\[([^\]]+)\]\([^)]*\)/, '$1').trim();
    const statusLabel = (cells[2] ?? '').trim();
    const context = truncate((cells[4] ?? cells[3] ?? '').trim());
    if (title.length > 0 && statusLabel.length > 0 && context.length > 0) {
      metadata.set(fileName, { title, statusLabel, context });
    }
  }
  return metadata;
}

function readAdrMetadata(absolutePath: string, id: string): Pick<AdrIndexEntry, 'title' | 'statusLabel' | 'context'> {
  const lines = fs.readFileSync(absolutePath, 'utf8').split(/\r?\n/);
  const heading = lines.find((line) => /^#\s+/.test(line));
  const title = heading === undefined
    ? id
    : heading.replace(/^#\s+(?:ADR-\d{3,}:\s*)?/i, '').trim();

  return {
    title: title || id,
    statusLabel: extractSectionParagraph(lines, STATUS_HEADINGS) || 'Sin estado',
    context: truncate(extractSectionParagraph(lines, CONTEXT_HEADINGS) || 'Sin contexto'),
  };
}

/**
 * Section headings that carry an ADR's status, in every form this repository
 * has used.
 *
 * The first four records were written in Spanish; every record from ADR-005 on
 * is in English, as the project convention requires. Recognising only the
 * Spanish heading left 16 of 20 records reporting `Sin estado` and
 * `Sin contexto` to `list_adrs` — the agent could read their titles and nothing
 * else, which is most of what ADR-004 exists to provide.
 */
const STATUS_HEADINGS = ['Estado', 'Status'];

/** Section headings that carry an ADR's context. @see STATUS_HEADINGS */
const CONTEXT_HEADINGS = ['Contexto', 'Context'];

/**
 * Reads the first paragraph under the first matching section heading.
 *
 * @param lines - The record split into lines.
 * @param sections - Accepted heading spellings, tried in order.
 * @returns The paragraph, or an empty string when no heading matches.
 */
function extractSectionParagraph(lines: string[], sections: string[]): string {
  const sectionIndex = lines.findIndex((line) => sections.some(
    (section) => new RegExp(`^##\\s+${section}\\s*$`, 'i').test(line),
  ));
  if (sectionIndex === -1) return '';

  const paragraph: string[] = [];
  let started = false;
  for (const line of lines.slice(sectionIndex + 1)) {
    if (/^#{1,6}\s+/.test(line)) break;
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      if (started) break;
      continue;
    }
    started = true;
    paragraph.push(trimmed);
  }

  return paragraph.join(' ');
}

function matchesCandidates(entries: AdrIndexEntry[], candidates: AdrCandidate[]): boolean {
  if (entries.length !== candidates.length) return false;

  return entries.every((entry, index) => {
    const candidate = candidates[index];
    return entry.id === candidate.id
      && entry.module === candidate.module
      && entry.path === candidate.path
      && entry.size === candidate.size
      && entry.mtimeMs === candidate.mtimeMs;
  });
}

function readCache(cachePath: string): AdrIndexCache | undefined {
  if (!fs.existsSync(cachePath)) return undefined;

  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    return isCache(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isCache(value: unknown): value is AdrIndexCache {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.version === CACHE_VERSION
    && typeof record.generatedAt === 'string'
    && Array.isArray(record.entries)
    && record.entries.every(isEntry);
}

function isEntry(value: unknown): value is AdrIndexEntry {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string'
    && typeof record.module === 'string'
    && typeof record.path === 'string'
    && typeof record.title === 'string'
    && typeof record.statusLabel === 'string'
    && typeof record.context === 'string'
    && typeof record.size === 'number'
    && typeof record.mtimeMs === 'number';
}

function truncate(value: string): string {
  return value.length <= MAX_CONTEXT_LENGTH
    ? value
    : `${value.slice(0, MAX_CONTEXT_LENGTH - 1)}…`;
}
