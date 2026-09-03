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

  constructor() {
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
    return [
      {
        id: uuidv4(),
        type: 'file',
        content: sourceFile.getFullText(),
        metadata: {
          startLine: 1,
          endLine: sourceFile.getEndLineNumber(),
          className: this.getClassName(sourceFile),
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
   * Keeps imports (from file), class decorators, properties, and constructor.
   */
  private extractClassContext(cls: ClassDeclaration): string {
    // We clone the structure to manipulate text without breaking the original AST
    // Ideally, we construct a string string representation:
    let text = cls
      .getDecorators()
      .map((d) => d.getText())
      .join('\n');
    text += `\nexport class ${cls.getName()} {\n`;

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

    // Prepend Imports from the source file for full context
    const imports = cls
      .getSourceFile()
      .getImportDeclarations()
      .map((i) => i.getText())
      .join('\n');
    return `${imports}\n\n${text}`;
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
    const imports = sourceFile.getImportDeclarations();

    // Necesitamos el directorio absoluto para resolver, así que combinamos CWD + sourcePath
    // Nota: Asumimos que sourcePath entra como relativa, ej: 'src/users/users.service.ts'
    const absoluteSourcePath = path.resolve(process.cwd(), sourcePath);
    const sourceDir = path.dirname(absoluteSourcePath);

    for (const imp of imports) {
      const moduleSpecifier = imp.getModuleSpecifierValue();

      // 1. Filter: We only care about internal relative imports (starting with '.')
      if (moduleSpecifier.startsWith('.')) {
        // 2. Resolution: Find the physical .ts file on disk
        const resolvedPath = this.resolveModulePath(sourceDir, moduleSpecifier);

        // 3. Validation: Only link if the file actually exists
        if (resolvedPath) {
          // 4. Normalization: Convert back to relative path for the Database
          // We use split/join to force forward slashes (/) even on Windows for DB consistency.
          const relativeTarget = path
            .relative(process.cwd(), resolvedPath)
            .split(path.sep)
            .join('/');

          edges.push({
            sourcePath: sourcePath, // Already relative
            targetPath: relativeTarget,
            relation: 'import',
          });
        }
      }
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
