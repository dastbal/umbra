/**
 * Represents the type of relation between two files in the project.
 * - 'import': Standard ES6 import.
 * - 're-export': `export * from` or `export { x } from` — a dependency that
 *   passes the target's surface through instead of consuming it. Kept distinct
 *   from 'import' because `query_dependency_graph` prints the relation, and a
 *   caller asking what breaks when a module changes is helped by knowing the
 *   edge runs through a barrel.
 * - 'require': a relative `require()` call. Rare here and never accidental — it
 *   appears where a module is loaded lazily on purpose, which is exactly the
 *   dependency a reader most needs the graph to carry.
 * - 'dynamic-import': a relative `import()` call, the same shape.
 * - 'extends': Class inheritance.
 * - 'implements': Interface implementation.
 */
export type DependencyRelation =
  | 'import'
  | 're-export'
  | 'require'
  | 'dynamic-import'
  | 'extends'
  | 'implements'
  | 'injects';

/**
 * Represents the granularity of a code chunk.
 * - 'file': The whole file (e.g., DTOs, Entities).
 * - 'method': A specific function inside a class (e.g., Service methods).
 * - 'class_signature': The class definition line + properties (Parent context).
 */
export type ChunkType = 'file' | 'method' | 'class_signature' | 'config';

/**
 * Structure of a row in the Dependency Graph table.
 */
export interface GraphEdge {
  sourcePath: string;
  targetPath: string;
  relation: DependencyRelation;
}

/**
 * Metadata stored alongside vectors to help the LLM understand context.
 */
export interface ChunkMetadata {
  startLine: number;
  endLine: number;
  decorators?: string[];
  className?: string;
  methodName?: string;
  /** TSDoc attached to the indexed symbol, when the AST exposed one. */
  documentation?: string;
  /** One-based position when a source unit is split for safe embedding. */
  fragmentIndex?: number;
  /** Number of stored fragments produced from the original source unit. */
  fragmentCount?: number;
  /** Non-TypeScript artifact that supplied this evidence, when applicable. */
  artifactKind?: 'prisma-schema';
}

/**
 * Represents a processed piece of code ready for storage.
 */
export interface ProcessedChunk {
  id: string; // UUID
  filePath?: string;
  type: ChunkType; // 'file' | 'method' | 'class_signature'
  content: string; // The code text
  metadata: ChunkMetadata; // Lines, decorators, etc.
  parentId?: string; // If this is a method, who is the parent class chunk?
}

/**
 * Full analysis result of a single file.
 */
export interface FileAnalysisResult {
  filePath: string;
  fileHash: string;
  chunks: ProcessedChunk[];
  dependencies: GraphEdge[];
  skeleton: object | null; // The simplified structure for the registry
}
