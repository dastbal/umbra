import * as fs from 'fs';
import * as path from 'path';

import { resolveWorkspacePath } from '../security';

const IGNORED_DIRECTORIES = new Set([
  'node_modules', '.git', 'dist', '.next', '.pnpm-store', '.umbra', '.claude',
]);
const UNHELPFUL_FILENAMES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb']);
const BINARY_EXTENSIONS = new Set(['.7z', '.avi', '.bmp', '.class', '.dll', '.doc', '.docx', '.exe', '.gif', '.gz', '.ico', '.jar', '.jpeg', '.jpg', '.mov', '.mp3', '.mp4', '.pdf', '.png', '.tar', '.ttf', '.wasm', '.woff', '.woff2', '.zip']);
const SECRET_EXTENSIONS = new Set(['.key', '.p12', '.pfx', '.pem']);
const MAX_FILE_BYTES = 1_000_000;
const MAX_SCAN_BYTES = 10_000_000;
const MAX_SCAN_FILES = 1_000;
const MAX_LINE_LENGTH = 500;
const DEFAULT_MAX_MATCHES = 100;

/** A supported non-indexed artifact class reported by the workspace inventory. */
export type WorkspaceEvidenceType =
  | 'graphql'
  | 'json'
  | 'markdown'
  | 'prisma'
  | 'properties'
  | 'sql'
  | 'toml'
  | 'typescript'
  | 'xml'
  | 'yaml';

/** A literal source location discovered without semantic retrieval. */
export interface WorkspaceLiteralMatch {
  readonly path: string;
  readonly line: number;
  readonly text: string;
  readonly artifactType: WorkspaceEvidenceType;
}

/** Metadata-only description of the safe portion of a pinned workspace. */
export interface WorkspaceInventory {
  readonly filesByType: Readonly<Record<string, number>>;
  readonly excludedByReason: Readonly<Record<string, number>>;
}

/** Input accepted by the bounded literal workspace search. */
export interface WorkspaceSearchInput {
  readonly query: string;
  readonly path?: string;
  readonly maxMatches?: number;
}

/** Result of a literal workspace scan, independent of its presentation adapter. */
export interface WorkspaceSearch {
  readonly query: string;
  readonly matches: readonly WorkspaceLiteralMatch[];
  readonly scannedFiles: number;
  readonly excludedByReason: Readonly<Record<string, number>>;
  readonly truncated: boolean;
}

/** Raised when a caller asks the evidence service to leave its pinned repository. */
export class WorkspaceEvidenceError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'WorkspaceEvidenceError';
  }
}

/**
 * Safely inventories and searches text artifacts that are intentionally outside Umbra's semantic index.
 *
 * The service never accepts an absolute root from a tool call. It is constructed with the server's
 * already-pinned root, ignores secret-like and generated paths before reading them, and returns only
 * bounded literal matches. Semantic ranking belongs to `ask_codebase`; this service is its live-evidence peer.
 */
export class WorkspaceEvidenceService {
  private readonly rootDir: string;

  /** Creates a service bound to one existing repository root. */
  public constructor(rootDir: string) {
    const resolved = resolveWorkspacePath(path.resolve(rootDir), '.');
    if (resolved === undefined) throw new WorkspaceEvidenceError('The repository root cannot be resolved safely.');
    this.rootDir = resolved;
  }

  /** Lists safe artifact-type counts without reading any file contents. */
  public inspect(): WorkspaceInventory {
    const filesByType: Record<string, number> = {};
    const excludedByReason: Record<string, number> = {};
    for (const file of this.collectFiles('.', excludedByReason)) {
      filesByType[file.type] = (filesByType[file.type] ?? 0) + 1;
    }
    return { filesByType: orderedCounts(filesByType), excludedByReason: orderedCounts(excludedByReason) };
  }

  /** Searches approved text artifacts for one literal string, with strict file, byte, and match budgets. */
  public search(input: WorkspaceSearchInput): WorkspaceSearch {
    const query = input.query.trim();
    if (query.length === 0) throw new WorkspaceEvidenceError('A literal search query is required.');
    const maxMatches = input.maxMatches ?? DEFAULT_MAX_MATCHES;
    if (!Number.isInteger(maxMatches) || maxMatches < 1 || maxMatches > DEFAULT_MAX_MATCHES) {
      throw new WorkspaceEvidenceError(`maxMatches must be an integer between 1 and ${DEFAULT_MAX_MATCHES}.`);
    }
    const relativePath = input.path ?? '.';
    const target = resolveWorkspacePath(this.rootDir, relativePath);
    if (target === undefined) throw new WorkspaceEvidenceError(`The search path escapes the repository: ${relativePath}`);
    if (!fs.existsSync(target)) throw new WorkspaceEvidenceError(`The search path does not exist: ${relativePath}`);

    const excludedByReason: Record<string, number> = {};
    const candidates = this.collectFiles(relativePath, excludedByReason);
    const matches: WorkspaceLiteralMatch[] = [];
    let scannedFiles = 0;
    let scannedBytes = 0;
    let truncated = false;

    for (const candidate of candidates) {
      if (scannedFiles >= MAX_SCAN_FILES || scannedBytes >= MAX_SCAN_BYTES) {
        truncated = true;
        break;
      }
      const size = fs.statSync(candidate.absolutePath).size;
      if (size > MAX_FILE_BYTES) {
        increment(excludedByReason, 'oversized-file');
        continue;
      }
      if (scannedBytes + size > MAX_SCAN_BYTES) {
        truncated = true;
        break;
      }
      const content = fs.readFileSync(candidate.absolutePath, 'utf8');
      scannedFiles += 1;
      scannedBytes += size;
      if (content.includes('\u0000')) {
        increment(excludedByReason, 'binary-content');
        continue;
      }
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        if (!lines[index].includes(query)) continue;
        matches.push({
          path: candidate.relativePath,
          line: index + 1,
          text: truncateLine(lines[index]),
          artifactType: candidate.type,
        });
        if (matches.length >= maxMatches) {
          truncated = true;
          break;
        }
      }
      if (truncated) break;
    }

    return {
      query,
      matches,
      scannedFiles,
      excludedByReason: orderedCounts(excludedByReason),
      truncated,
    };
  }

  /** Collects eligible files in deterministic order while rejecting paths before their contents are read. */
  private collectFiles(relativePath: string, excludedByReason: Record<string, number>): WorkspaceEvidenceFile[] {
    const target = resolveWorkspacePath(this.rootDir, relativePath);
    if (target === undefined) throw new WorkspaceEvidenceError(`The search path escapes the repository: ${relativePath}`);
    const normalizedTarget = toRelativePath(this.rootDir, target);
    if (normalizedTarget.split('/').some((segment) => IGNORED_DIRECTORIES.has(segment))) {
      throw new WorkspaceEvidenceError(`The search path is excluded by policy: ${relativePath}`);
    }
    const files: WorkspaceEvidenceFile[] = [];
    const visit = (current: string): void => {
      const entries = fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const absolutePath = path.join(current, entry.name);
        if (entry.isSymbolicLink()) {
          increment(excludedByReason, 'symlink');
          continue;
        }
        if (entry.isDirectory()) {
          if (IGNORED_DIRECTORIES.has(entry.name)) increment(excludedByReason, 'ignored-directory');
          else visit(absolutePath);
          continue;
        }
        if (entry.isFile()) this.addFile(absolutePath, files, excludedByReason);
      }
    };
    const targetEntry = fs.lstatSync(target);
    if (targetEntry.isSymbolicLink()) {
      increment(excludedByReason, 'symlink');
    } else if (targetEntry.isFile()) {
      this.addFile(target, files, excludedByReason);
    } else {
      visit(target);
    }
    return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  }

  /** Applies the same pre-read policy to a direct-file search as to a recursive scan. */
  private addFile(absolutePath: string, files: WorkspaceEvidenceFile[], excludedByReason: Record<string, number>): void {
    const relative = toRelativePath(this.rootDir, absolutePath);
    const reason = exclusionReason(relative);
    if (reason !== undefined) {
      increment(excludedByReason, reason);
      return;
    }
    const type = evidenceType(relative);
    if (type === undefined) {
      increment(excludedByReason, 'unsupported-type');
      return;
    }
    if (resolveWorkspacePath(this.rootDir, relative) === undefined) {
      increment(excludedByReason, 'path-escape');
      return;
    }
    files.push({ absolutePath, relativePath: relative, type });
  }
}

interface WorkspaceEvidenceFile {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly type: WorkspaceEvidenceType;
}

/** Returns the public artifact class for an allowed text path. */
function evidenceType(relativePath: string): WorkspaceEvidenceType | undefined {
  const extension = path.extname(relativePath).toLowerCase();
  if (extension === '.ts' || extension === '.tsx') return 'typescript';
  if (extension === '.prisma') return 'prisma';
  if (extension === '.sql') return 'sql';
  if (extension === '.json') return 'json';
  if (extension === '.yaml' || extension === '.yml') return 'yaml';
  if (extension === '.md') return 'markdown';
  if (extension === '.graphql' || extension === '.gql') return 'graphql';
  if (extension === '.toml') return 'toml';
  if (extension === '.xml') return 'xml';
  if (extension === '.properties') return 'properties';
  return undefined;
}

/** Identifies paths whose content must never enter the model-facing search result. */
function exclusionReason(relativePath: string): string | undefined {
  const basename = path.basename(relativePath).toLowerCase();
  const extension = path.extname(basename);
  if (basename === '.env' || basename.startsWith('.env.')) return 'secret-like-path';
  if (SECRET_EXTENSIONS.has(extension)) return 'secret-like-path';
  if (UNHELPFUL_FILENAMES.has(basename) || BINARY_EXTENSIONS.has(extension)) return 'unhelpful-artifact';
  return undefined;
}

/** Converts one absolute filesystem path into Umbra's stable slash-separated identity. */
function toRelativePath(rootDir: string, absolutePath: string): string {
  return path.relative(rootDir, absolutePath).split(path.sep).join('/');
}

/** Increments one diagnostic counter. */
function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

/** Stabilizes public maps for deterministic tool and test output. */
function orderedCounts(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

/** Bounds one model-facing source line without hiding that it was shortened. */
function truncateLine(line: string): string {
  return line.length <= MAX_LINE_LENGTH ? line : `${line.slice(0, MAX_LINE_LENGTH - 1)}…`;
}
