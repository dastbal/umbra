import * as fs from 'fs';
import * as path from 'path';
import { agentPath } from '../config/agent-directory';

const CACHE_VERSION = 1;
const ADR_FILE_PATTERN = /^(ADR-\d{3,})-.+\.md$/i;
const MAX_CONTEXT_LENGTH = 220;

/** A compact, project-relative description of one Architecture Decision Record. */
export interface AdrIndexEntry {
  /** Stable ADR identifier parsed from its filename. */
  id: string;
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
  path: string;
  absolutePath: string;
  size: number;
  mtimeMs: number;
}

/**
 * Builds or reuses a local catalog of Architecture Decision Records.
 *
 * The catalog contains only the decision identifier, title, status, and a
 * bounded context paragraph. It is written to `.agent/adr-index.json` so an
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
    ...readAdrMetadata(candidate.absolutePath, candidate.id),
  })).map(({ absolutePath: _absolutePath, ...entry }) => entry);
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
  if (index.entries.length === 0) {
    return 'ADR catalog (cached): no decision records found in docs/adr.';
  }

  const lines = index.entries.map((entry) =>
    `- ${entry.id} — ${entry.title} [${entry.statusLabel}]; context: ${entry.context}`,
  );

  return `ADR catalog (${index.status}; ${index.entries.length} decisions):\n${lines.join('\n')}`;
}

function discoverAdrs(rootDir: string): AdrCandidate[] {
  const adrDirectory = path.join(rootDir, 'docs', 'adr');
  if (!fs.existsSync(adrDirectory)) return [];

  const candidates: AdrCandidate[] = [];
  for (const entry of fs.readdirSync(adrDirectory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const match = ADR_FILE_PATTERN.exec(entry.name);
    if (match === null) continue;

    const absolutePath = path.resolve(adrDirectory, entry.name);
    const stat = fs.statSync(absolutePath);
    candidates.push({
      id: match[1].toUpperCase(),
      path: path.join('docs', 'adr', entry.name).split(path.sep).join('/'),
      absolutePath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    });
  }

  return candidates.sort((left, right) => left.id.localeCompare(right.id));
}

function readAdrMetadata(absolutePath: string, id: string): Pick<AdrIndexEntry, 'title' | 'statusLabel' | 'context'> {
  const lines = fs.readFileSync(absolutePath, 'utf8').split(/\r?\n/);
  const heading = lines.find((line) => /^#\s+/.test(line));
  const title = heading === undefined
    ? id
    : heading.replace(/^#\s+(?:ADR-\d{3,}:\s*)?/i, '').trim();

  return {
    title: title || id,
    statusLabel: extractSectionParagraph(lines, 'Estado') || 'Sin estado',
    context: truncate(extractSectionParagraph(lines, 'Contexto') || 'Sin contexto'),
  };
}

function extractSectionParagraph(lines: string[], section: string): string {
  const sectionIndex = lines.findIndex((line) => new RegExp(`^##\\s+${section}\\s*$`, 'i').test(line));
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
