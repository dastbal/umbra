/**
 * Represents the type of relation between two files in the project.
 * - 'import': Standard ES6 import.
 * - 'extends': Class inheritance.
 * - 'implements': Interface implementation.
 */
export type DependencyRelation =
  | 'import'
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
