import {
  Project,
  SourceFile,
  SyntaxKind,
  MethodDeclaration,
  ClassDeclaration,
} from 'ts-morph';
// Node's own UUID generator rather than the `uuid` package.
//
// `uuid@13` is ESM-only: its exports map has no `require` condition, so
// `require('uuid')` from this CommonJS build works only on Node 22+, which
// permits requiring an ES module. This package declares `engines: node >= 20`,
// where the same call throws. The bug was invisible until `moduleResolution`
// moved off Node 10 resolution, which does not read exports maps at all.
//
// `randomUUID` has been in `node:crypto` since Node 14.17, is faster, and
// removes a dependency instead of pinning one.
import { randomUUID as uuidv4 } from 'node:crypto';
import {
  ProcessedChunk,
  ChunkMetadata,
  GraphEdge,
  DependencyRelation,
  FileAnalysisResult,
} from '../../types';
import * as path from 'path';
import * as fs from 'fs'; // Necesario para verificar si existe el archivo .ts o index.ts
/**
 * The Brain Surgeon 🩺
 * Analyzes TypeScript files using AST to extract intelligent code chunks and dependency graphs.
 * Optimized for NestJS architecture patterns.
 */
export class NestChunker {
  private project: Project;
  private readonly rootDir: string;

  constructor(rootDir: string = process.cwd()) {
    this.rootDir = path.resolve(rootDir);
    // Initialize ts-morph project.
    // We skip loading the whole tsconfig for speed, processing files individually.
    this.project = new Project({
      skipAddingFilesFromTsConfig: true,
      useInMemoryFileSystem: true,
    });
  }

  /**
   * Analyzes a file content and breaks it down based on its type (Service, DTO, Module).
   * * @param filePath - The relative path of the file.
   * @param content - The raw string content of the file.
   * @param fileHash - The MD5 hash for registry tracking.
   */
  public analyze(
    filePath: string,
    content: string,
    fileHash: string,
  ): FileAnalysisResult {
    // 1. Create AST from content
    const sourceFile = this.project.createSourceFile(filePath, content, {
      overwrite: true,
    });

    // 2. Determine Strategy based on file extension/name
    const isAtomic = this.isAtomicFile(filePath);

    // 3. Extract Dependencies (Imports) -> For the Knowledge Graph
    const dependencies = this.extractDependencies(sourceFile, filePath);

    // 4. Generate Chunks
    let chunks: ProcessedChunk[] = [];

    if (isAtomic) {
      chunks = this.processAtomicFile(sourceFile);
    } else {
      chunks = this.processLogicFile(sourceFile);
    }

    // A large part of real TypeScript infrastructure is module-oriented:
    // factories, CLI entry points, configuration adapters, and root resolvers
    // often export functions/constants without declaring a class. The former
    // class-only logic path returned no chunks for those valid files, which
    // made durable indexing leave them pending forever. A file-level fallback
    // preserves the no-empty-chunk invariant; oversized modules are split by
    // the embedding preparation layer before any provider call.
    if (chunks.length === 0 && sourceFile.getFullText().trim().length > 0) {
      chunks.push({
        id: uuidv4(),
        type: 'file',
        content: sourceFile.getFullText(),
        metadata: {
          startLine: 1,
          endLine: sourceFile.getEndLineNumber(),
        },
      });
    }

    // 5. Generate Skeleton (Simplified view for caching)
    // We reuse the logic: if it's atomic, skeleton is full file. If logic, it's signatures.
    const skeleton = isAtomic
      ? { type: 'full', content: '...' }
      : this.generateSkeleton(sourceFile);

    return {
      filePath,
      fileHash,
      chunks,
      dependencies,
      skeleton,
    };
  }

  // ==========================================
  // 🕵️ STRATEGIES
  // ==========================================

  /**
   * Checks if the file should be treated as a single atomic unit.
   * Rules: DTOs, Entities, Interfaces, Enums.
   */
  private isAtomicFile(filePath: string): boolean {
    return (
      filePath.endsWith('.dto.ts') ||
      filePath.endsWith('.entity.ts') ||
      filePath.endsWith('.interface.ts') ||
      filePath.endsWith('.enum.ts') ||
      filePath.endsWith('.type.ts')
    );
  }

  /**
   * Strategy A: Atomic Processing
   * Stores the whole file as one chunk. Essential for DTOs/Entities context.
   */
  private processAtomicFile(sourceFile: SourceFile): ProcessedChunk[] {
    const classDeclaration = sourceFile.getClasses()[0];
    return [
      {
        id: uuidv4(),
        type: 'file',
        content: sourceFile.getFullText(),
        metadata: {
          startLine: 1,
          endLine: sourceFile.getEndLineNumber(),
          className: this.getClassName(sourceFile),
          documentation: classDeclaration === undefined
            ? undefined
            : this.documentationOf(classDeclaration),
        },
      },
    ];
  }

  /**
   * Strategy B: Logic Processing (Parent-Child)
   * Splits Services/Controllers into Class Context (Parent) and Methods (Children).
   */
  private processLogicFile(sourceFile: SourceFile): ProcessedChunk[] {
    const chunks: ProcessedChunk[] = [];
    const classes = sourceFile.getClasses();

    for (const cls of classes) {
      // 1. Create Parent Chunk (The Class Context)
      // Includes: Decorators, Properties, Constructor. Excludes: Method Bodies.
      const parentId = uuidv4();
      const classContext = this.extractClassContext(cls);

      chunks.push({
        id: parentId,
        type: 'class_signature',
        content: classContext,
        metadata: {
          startLine: cls.getStartLineNumber(),
          endLine: cls.getEndLineNumber(),
          className: cls.getName(),
          decorators: cls.getDecorators().map((d) => d.getName()),
          documentation: this.documentationOf(cls),
        },
      });

      // 2. Create Child Chunks (The Methods)
      const methods = cls.getMethods();
      for (const method of methods) {
        chunks.push({
          id: uuidv4(),
          parentId: parentId, // Link to Parent!
          type: 'method',
          content: method.getFullText(), // Method logic
          metadata: {
            startLine: method.getStartLineNumber(),
            endLine: method.getEndLineNumber(),
            className: cls.getName(),
            methodName: method.getName(),
            decorators: method.getDecorators().map((d) => d.getName()),
            documentation: this.documentationOf(method),
          },
        });
      }
    }

    return chunks;
  }

  // ==========================================
  // 🛠️ HELPERS
  // ==========================================

  /**
   * Extracts the "Context" of a class without the heavy method implementation.
   * Keeps the declaration, decorators, properties, and constructor.
   */
  private extractClassContext(cls: ClassDeclaration): string {
    let text = cls
      .getDecorators()
      .map((d) => d.getText())
      .join('\n');
    if (text.length > 0) text += '\n';
    text += `${this.classDeclarationHeader(cls)} {\n`;

    // Add properties (e.g., private readonly userService: UserService;)
    cls.getProperties().forEach((prop) => {
      text += `  ${prop.getText()}\n`;
    });

    // Add constructor
    const ctor = cls.getConstructors()[0];
    if (ctor) {
      text += `  ${ctor.getText()}\n`;
    }

    text += `  // Methods are indexed separately as child chunks...\n`;
    text += `}`;
    return text;
  }

  /**
   * Rebuilds only the declaration header from AST facts, never from a generic
   * `export class` template that could erase abstractness or inheritance.
   *
   * @param cls - Parsed class declaration whose executable context is indexed.
   * @returns A syntactically faithful class header without its opening brace.
   */
  private classDeclarationHeader(cls: ClassDeclaration): string {
    const modifiers = cls.getModifiers().map((modifier) => modifier.getText()).join(' ');
    const name = cls.getName() ?? 'AnonymousClass';
    const typeParameters = cls.getTypeParameters().map((parameter) => parameter.getText()).join(', ');
    const extendsClause = cls.getExtends();
    const implementsClauses = cls.getImplements();
    const parts = [
      modifiers,
      'class',
      `${name}${typeParameters.length === 0 ? '' : `<${typeParameters}>`}`,
      ...(extendsClause === undefined ? [] : [`extends ${extendsClause.getText()}`]),
      ...(implementsClauses.length === 0
        ? []
        : [`implements ${implementsClauses.map((clause) => clause.getText()).join(', ')}`]),
    ];
    return parts.filter((part) => part.length > 0).join(' ');
  }

  /**
   * Reads the documentation attached to one declaration without guessing from
   * nearby comments. Keeping it structured lets lexical retrieval weight the
   * explanation independently from implementation text.
   *
   * @param declaration - A class or method declaration from the source AST.
   * @returns The joined TSDoc blocks, or undefined when none exist.
   */
  private documentationOf(declaration: ClassDeclaration | MethodDeclaration): string | undefined {
    const documentation = declaration
      .getJsDocs()
      .map((doc) => doc.getText().trim())
      .filter((doc) => doc.length > 0)
      .join('\n');
    return documentation.length === 0 ? undefined : documentation;
  }

  /**
   * Extracts static import relationships to build the Dependency Graph.
   * It parses the AST to find all relative imports and resolves them to physical files.
   * * @param sourceFile - The AST SourceFile object from ts-morph.
   * @param sourcePath - The relative path of the file currently being analyzed (e.g., 'src/auth/auth.service.ts').
   * @returns An array of graph edges representing 'import' relationships.
   */
  private extractDependencies(
    sourceFile: SourceFile,
    sourcePath: string,
  ): GraphEdge[] {
    const edges: GraphEdge[] = [];

    // Necesitamos el directorio absoluto para resolver, así que combinamos CWD + sourcePath
    // Nota: Asumimos que sourcePath entra como relativa, ej: 'src/users/users.service.ts'
    const absoluteSourcePath = path.resolve(this.rootDir, sourcePath);
    const sourceDir = path.dirname(absoluteSourcePath);

    /**
     * Records one edge for a module specifier, when it names a file on disk.
     *
     * Shared by imports and re-exports so the two cannot drift: the filter, the
     * resolution and the normalization below are the same rules whichever node
     * kind the specifier came from.
     *
     * @param moduleSpecifier - The specifier as written, or `undefined` for an
     * export with no `from` clause, which re-exports nothing.
     * @param relation - How the source depends on the target.
     */
    const link = (
      moduleSpecifier: string | undefined,
      relation: DependencyRelation,
    ): void => {
      // 1. Filter: We only care about internal relative imports (starting with '.')
      if (moduleSpecifier === undefined || !moduleSpecifier.startsWith('.')) return;

      // 2. Resolution: Find the physical .ts file on disk
      const resolvedPath = this.resolveModulePath(sourceDir, moduleSpecifier);

      // 3. Validation: Only link if the file actually exists
      if (!resolvedPath) return;

      // 4. Normalization: Convert back to relative path for the Database
      // We use split/join to force forward slashes (/) even on Windows for DB consistency.
      const relativeTarget = path
        .relative(this.rootDir, resolvedPath)
        .split(path.sep)
        .join('/');

      edges.push({
        sourcePath: sourcePath, // Already relative
        targetPath: relativeTarget,
        relation,
      });
    };

    for (const imp of sourceFile.getImportDeclarations()) {
      link(imp.getModuleSpecifierValue(), 'import');
    }

    // `export * from './x'` and `export { y } from './x'` are ExportDeclarations,
    // not ImportDeclarations, so the loop above never saw them and they produced
    // no edge at all. Measured at 0 of 48 on this repository before this: every
    // genuine hole in the dependency graph was a re-export, and the worst case
    // was `src/index.ts` — the published package's barrel re-exports the whole
    // public surface, so the entry point a consumer actually imports had no
    // outbound edges, and "what breaks if I change this" never named it.
    for (const exported of sourceFile.getExportDeclarations()) {
      link(exported.getModuleSpecifierValue(), 're-export');
    }

    // `require('./x')` and `import('./x')` are call expressions, not
    // declarations, so neither loop above reaches them. They were left out at
    // first because this tree held exactly one relative `require`, in a spec —
    // unmeasurable, and reported as such. That changed the moment
    // `start-mcp-server.ts` began loading the indexer lazily to keep it off the
    // handshake: three deliberate relative requires appeared in indexed source,
    // and the graph arm reported three gaps in the next run.
    //
    // A lazily loaded module is not a lesser dependency. It is the one a reader
    // is least likely to find by eye, which is the whole reason to record it.
    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression().getText();
      if (callee !== 'require' && callee !== 'import') continue;

      const [argument] = call.getArguments();
      if (argument === undefined) continue;
      // Read from the literal rather than the type system: a computed specifier
      // has no static target, so no graph could carry it honestly.
      const literal = /^['"](.+)['"]$/.exec(argument.getText());
      if (literal === null) continue;

      link(literal[1], callee === 'require' ? 'require' : 'dynamic-import');
    }

    return edges;
  }

  private getClassName(sourceFile: SourceFile): string | undefined {
    return sourceFile.getClasses()[0]?.getName();
  }

  private generateSkeleton(sourceFile: SourceFile): object {
    return {
      // 1. Guardamos imports visuales para que el LLM sepa de dónde vienen los tipos
      imports: sourceFile.getImportDeclarations().map((i) => i.getText()),

      classes: sourceFile.getClasses().map((c) => ({
        name: c.getName(),
        // 2. MEJORA: No guardes solo el nombre "create".
        // Guarda la firma: "create(dto: CreateUserDto): Promise<User>"
        // Cortamos justo antes de la llave '{' para quitar el cuerpo.
        methods: c.getMethods().map((m) => {
          // Obtiene solo la estructura (nombre, args, retorno)
          //   const structure = m.getStructure();
          // O reconstrúyelo simple:
          return `${m.getName()}(${m
            .getParameters()
            .map((p) => p.getText())
            .join(', ')}): ${m.getReturnType().getText()};`;
        }),
      })),
    };
  }

  /**
   * Resolves the physical filesystem path for a given import string.
   * Handles TypeScript resolution strategies including file extensions and directory indexes.
   * * @param sourceDir - The absolute directory path of the file containing the import.
   * @param importPath - The raw import string (e.g., './users.service' or './dto').
   * @returns The absolute path to the resolved .ts file, or `null` if not found/external.
   * * @example
   * resolveModulePath('/src/users', './dto');
   * // Returns: '/src/users/dto/index.ts'
   */
  private resolveModulePath(
    sourceDir: string,
    importPath: string,
  ): string | null {
    // 1. Construct the potential absolute path
    const absoluteBase = path.join(sourceDir, importPath);

    // Case A: Explicit file extension (rare in imports, but valid)
    // import ... from './file.ts'
    if (fs.existsSync(absoluteBase) && fs.statSync(absoluteBase).isFile()) {
      return absoluteBase;
    }

    // Case B: Implicit .ts extension (Most common)
    // import ... from './users.service' -> checks users.service.ts
    const tsPath = `${absoluteBase}.ts`;
    if (fs.existsSync(tsPath)) {
      return tsPath;
    }

    // Case C: Directory Index (Barrel Files)
    // import ... from './dto' -> checks dto/index.ts
    const indexPath = path.join(absoluteBase, 'index.ts');
    if (fs.existsSync(indexPath)) {
      return indexPath;
    }

    // Case D: Resolution failed
    // Could be a node_module, a path alias (@src/...), or a non-existent file.
    return null;
  }
}
