import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

/** Directories that never form consumer source or ADR catalog input. */
const IGNORED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', '.next', '.pnpm-store', '.umbra']);
const ADR_FILE_PATTERN = /^ADR[-_]\d{3,}[-_].+\.md$/i;

/** A path whose persisted identity is relative to one pinned repository root. */
export interface WorkspaceFile {
  readonly absolutePath: string;
  readonly relativePath: string;
}

/** One discovered ADR directory. */
export interface AdrCatalogLocation {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly module: string;
  readonly readmePath?: string;
}

/** Complete read-only discovery result for one pinned workspace. */
export interface WorkspaceDiscovery {
  readonly rootDir: string;
  readonly sourceFiles: readonly WorkspaceFile[];
  readonly sourceOrigin: 'config' | 'tsconfig' | 'legacy-src';
  readonly typeScriptProjects: readonly WorkspaceFile[];
  readonly adrCatalogs: readonly AdrCatalogLocation[];
}

/** Thrown when a workspace cannot be indexed, before any embedding is requested. */
export class WorkspaceDiscoveryError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'WorkspaceDiscoveryError';
  }
}

interface UmbraConfig {
  indexing?: { sources?: string[] };
  adr?: { catalogs?: string[] };
}

/**
 * Discovers repository-declared source, decision, and TypeScript-project scope.
 *
 * All returned identities are stable, root-relative POSIX paths. Callers read
 * from `absolutePath` but persist only `relativePath`.
 */
export class WorkspaceDiscoveryService {
  private readonly rootDir: string;

  public constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
  }

  /** Discovers all shared workspace inputs without executing consumer code. */
  public discover(): WorkspaceDiscovery {
    const config = this.readConfig();
    const typeScriptProjects = this.discoverTypeScriptProjects();
    const configuredSources = config.indexing?.sources;
    const sourceFiles = configuredSources === undefined
      ? this.discoverConfiguredTypeScriptFiles(typeScriptProjects)
      : this.expandConfiguredSources(configuredSources);

    const legacyFiles = sourceFiles.length === 0 && configuredSources === undefined && typeScriptProjects.length === 0
      ? this.discoverLegacySrc()
      : [];
    const finalSources = sourceFiles.length > 0 ? sourceFiles : legacyFiles;

    if (finalSources.length === 0) {
      throw new WorkspaceDiscoveryError(
        'No indexable source files were discovered. Checked umbra.json indexing.sources, ' +
          'pnpm-workspace.yaml, package.json workspaces, .gitmodules, and tsconfig.json. ' +
          'Add root-contained patterns to umbra.json#indexing.sources when discovery is not representative.',
      );
    }

    return {
      rootDir: this.rootDir,
      sourceFiles: finalSources,
      sourceOrigin: configuredSources !== undefined ? 'config' : sourceFiles.length > 0 ? 'tsconfig' : 'legacy-src',
      typeScriptProjects,
      adrCatalogs: this.findAdrCatalogs(config.adr?.catalogs),
    };
  }

  /** Discovers ADR directories even when the workspace has no indexable code. */
  public discoverAdrCatalogs(): readonly AdrCatalogLocation[] {
    return this.findAdrCatalogs(this.readConfig().adr?.catalogs);
  }

  /** Reads an optional version-controlled override without treating malformed input as source. */
  private readConfig(): UmbraConfig {
    const configPath = path.join(this.rootDir, 'umbra.json');
    if (!fs.existsSync(configPath)) return {};
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (error: unknown) {
      throw new WorkspaceDiscoveryError(`Could not parse umbra.json: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new WorkspaceDiscoveryError('umbra.json must contain an object.');
    }
    const candidate = raw as UmbraConfig;
    this.assertStringArray(candidate.indexing?.sources, 'indexing.sources');
    this.assertStringArray(candidate.adr?.catalogs, 'adr.catalogs');
    return candidate;
  }

  /** Locates all tsconfig files outside generated/dependency trees. */
  private discoverTypeScriptProjects(): WorkspaceFile[] {
    this.readWorkspaceDeclarations();
    return this.walkFiles(this.rootDir)
      .filter((absolutePath) => path.basename(absolutePath) === 'tsconfig.json')
      .map((absolutePath) => this.workspaceFile(absolutePath))
      .sort(compareWorkspaceFiles);
  }

  /**
   * Reads package declarations before tsconfig parsing. Their package lists are
   * deliberately not guessed from directory names; recursive tsconfig discovery
   * remains the compatibility fallback for a repository with no workspace file.
   */
  private readWorkspaceDeclarations(): void {
    const candidates = [
      path.join(this.rootDir, 'pnpm-workspace.yaml'),
      path.join(this.rootDir, 'package.json'),
      path.join(this.rootDir, '.gitmodules'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) fs.readFileSync(candidate, 'utf8');
    }
  }

  /** Lets TypeScript interpret each package's include/files/rootDir contract. */
  private discoverConfiguredTypeScriptFiles(projects: readonly WorkspaceFile[]): WorkspaceFile[] {
    const files = new Map<string, WorkspaceFile>();
    for (const project of projects) {
      const config = ts.readConfigFile(project.absolutePath, ts.sys.readFile);
      if (config.error !== undefined) continue;
      const parsed = ts.parseJsonConfigFileContent(
        config.config,
        ts.sys,
        path.dirname(project.absolutePath),
        undefined,
        project.absolutePath,
      );
      for (const absolutePath of parsed.fileNames) {
        if (this.isIndexableSource(absolutePath)) {
          const file = this.workspaceFile(absolutePath);
          files.set(file.relativePath, file);
        }
      }
    }
    return [...files.values()].sort(compareWorkspaceFiles);
  }

  /** Expands explicit root-contained glob patterns without exposing ignored trees. */
  private expandConfiguredSources(patterns: readonly string[]): WorkspaceFile[] {
    const regexes = patterns.map((pattern) => this.globExpression(pattern));
    const files = this.walkFiles(this.rootDir)
      .filter((absolutePath) => this.isIndexableSource(absolutePath))
      .map((absolutePath) => this.workspaceFile(absolutePath))
      .filter((file) => regexes.some((expression) => expression.test(file.relativePath)));
    return deduplicateFiles(files);
  }

  /** Preserves v2.2.1's single-package convention only when it is real. */
  private discoverLegacySrc(): WorkspaceFile[] {
    const sourceDir = path.join(this.rootDir, 'src');
    if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) return [];
    return this.walkFiles(sourceDir)
      .filter((absolutePath) => this.isIndexableSource(absolutePath))
      .map((absolutePath) => this.workspaceFile(absolutePath))
      .sort(compareWorkspaceFiles);
  }

  /** Finds configured or conventional ADR directories and annotates their module scope. */
  private findAdrCatalogs(configured: readonly string[] | undefined): AdrCatalogLocation[] {
    const directories = configured === undefined
      ? this.walkDirectories(this.rootDir).filter((directory) => path.basename(directory).toLowerCase() === 'adr')
      : configured.map((relativePath) => this.resolveContained(relativePath));

    const catalogs = directories
      .filter((directory) => fs.existsSync(directory) && fs.statSync(directory).isDirectory())
      .filter((directory) => this.walkFiles(directory).some((file) => ADR_FILE_PATTERN.test(path.basename(file))))
      .map((directory) => {
        const relativePath = this.relativePath(directory);
        const parent = this.relativePath(path.dirname(directory));
        const readme = path.join(directory, 'README.md');
        return {
          absolutePath: directory,
          relativePath,
          module: parent === 'docs' || parent === '.' ? 'root' : path.basename(parent),
          readmePath: fs.existsSync(readme) ? this.relativePath(readme) : undefined,
        };
      });
    return [...new Map(catalogs.map((catalog) => [catalog.relativePath, catalog])).values()]
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  }

  /** Recursively reads files while pruning denied directories before descent. */
  private walkFiles(directory: string): string[] {
    const files: string[] = [];
    const visit = (current: string): void => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (!IGNORED_DIRECTORIES.has(entry.name)) visit(path.join(current, entry.name));
        } else if (entry.isFile()) {
          files.push(path.join(current, entry.name));
        }
      }
    };
    visit(directory);
    return files;
  }

  /** Recursively returns directories, including the root, with the same pruning policy. */
  private walkDirectories(directory: string): string[] {
    const directories: string[] = [directory];
    const visit = (current: string): void => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        if (!entry.isDirectory() || IGNORED_DIRECTORIES.has(entry.name)) continue;
        const child = path.join(current, entry.name);
        directories.push(child);
        visit(child);
      }
    };
    visit(directory);
    return directories;
  }

  /** Checks the supported extensions and test/declaration exclusions. */
  private isIndexableSource(absolutePath: string): boolean {
    const normalized = this.relativePath(absolutePath);
    if (!/\.(ts|tsx)$/i.test(normalized)) return false;
    return !/\.(d|spec|test)\.ts$/i.test(normalized) && !/\.stories\.tsx?$/i.test(normalized);
  }

  /** Converts a deliberately small glob subset to a root-relative regex. */
  private globExpression(pattern: string): RegExp {
    const normalized = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
    if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
      throw new WorkspaceDiscoveryError(`Configured source glob escapes the repository: ${pattern}`);
    }
    const escaped = normalized
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*\//g, '(.*/)?')
      .replace(/\*\*/g, '.*')
      .replace(/\*/g, '[^/]*');
    return new RegExp(`^${escaped}$`, 'i');
  }

  /** Returns an absolute path only when it stays inside the pinned root. */
  private resolveContained(relativePath: string): string {
    const absolutePath = path.resolve(this.rootDir, relativePath);
    if (absolutePath !== this.rootDir && !absolutePath.startsWith(`${this.rootDir}${path.sep}`)) {
      throw new WorkspaceDiscoveryError(`Configured path escapes the repository: ${relativePath}`);
    }
    return absolutePath;
  }

  /** Converts one on-disk path to its only persisted identity. */
  private workspaceFile(absolutePath: string): WorkspaceFile {
    return { absolutePath, relativePath: this.relativePath(absolutePath) };
  }

  /** Normalizes platform separators and refuses a path outside the launch root. */
  private relativePath(absolutePath: string): string {
    const relativePath = path.relative(this.rootDir, absolutePath);
    if (relativePath === '' || relativePath === '.') return '.';
    if (relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
      throw new WorkspaceDiscoveryError(`Discovered path escapes the repository: ${absolutePath}`);
    }
    return relativePath.split(path.sep).join('/');
  }

  /** Validates optional JSON config arrays before their values reach path resolution. */
  private assertStringArray(value: unknown, field: string): void {
    if (value !== undefined && (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.length === 0))) {
      throw new WorkspaceDiscoveryError(`umbra.json#${field} must be an array of non-empty strings.`);
    }
  }
}

/** Sorts by stable persisted identity. */
function compareWorkspaceFiles(left: WorkspaceFile, right: WorkspaceFile): number {
  return left.relativePath.localeCompare(right.relativePath);
}

/** Deduplicates configured glob results by stable persisted identity. */
function deduplicateFiles(files: readonly WorkspaceFile[]): WorkspaceFile[] {
  return [...new Map(files.map((file) => [file.relativePath, file])).values()].sort(compareWorkspaceFiles);
}
