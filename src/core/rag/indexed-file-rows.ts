import type Database from 'better-sqlite3';
import * as crypto from 'crypto';
import type { WorkspaceArtifactKind } from '../config/workspace-discovery';
import type { NestChunker } from '../tools/ast/chunker';
import { analyzeNestGraph, type NestGraph } from '../tools/ast/nest-graph';
import type { GraphEdge, ProcessedChunk } from '../types';
import type { EmbeddingsIdentity } from './embeddings/embeddings.port';
import { splitChunksForEmbedding } from './embedding-input';
import { replaceDependencyGraphForFile } from './dependency-graph-store';
import { replaceNestGraphForFile } from './nest-graph-store';
import type { PrismaSchemaChunker } from './prisma-schema-chunker';
import { encodeVector } from './vector-codec';

/**
 * The rows one source file contributes to the index, written in exactly one place.
 *
 * ## Why this is its own module
 *
 * The base indexer commits these rows durably. A worktree overlay (ADR-038)
 * writes the *same* rows for a worktree's version of a file inside a
 * transaction it never commits, so that every existing query reads the
 * worktree as if it had been indexed. If the overlay had its own copy of these
 * INSERTs, the two would drift — a column added to one and not the other is a
 * worktree answer that silently differs from an indexed one. One definition,
 * two callers.
 */

/** A chunk ready to store: the embedding split has run and its path is attached. */
export type StoredChunk = ProcessedChunk & { filePath: string };

/** Everything derived from one file's content, before any embedding call. */
export interface AnalyzedSourceFile {
  /** Root-relative POSIX path, the file's only persisted identity. */
  readonly relativePath: string;
  /** Parser that owns the file. */
  readonly kind: WorkspaceArtifactKind;
  /** md5 of the content, the registry's definition of "changed". */
  readonly hash: string;
  /** Structural skeleton stored in `file_registry.skeleton_signature`. */
  readonly skeleton: object | null;
  /** Chunks after the lossless embedding split. */
  readonly chunks: readonly StoredChunk[];
  /** Outgoing dependency edges. */
  readonly dependencies: readonly GraphEdge[];
  /** NestJS wiring, for TypeScript files only. */
  readonly nestGraph?: NestGraph;
  /** True when the content is empty or whitespace, which is stored as a skip. */
  readonly empty: boolean;
}

/** The parsers a file may need, owned by the caller so their root is the caller's. */
export interface SourceChunkers {
  /** TypeScript chunker, rooted where import targets must resolve. */
  readonly typescript: NestChunker;
  /** Prisma schema chunker. */
  readonly prisma: PrismaSchemaChunker;
}

/**
 * Parses one file's content into the rows it will contribute.
 *
 * @param chunkers - Parsers; the TypeScript one must be rooted at the checkout the file came from.
 * @param file - The file's identity and kind.
 * @param content - The file's content.
 * @returns The analysed file. `empty` is set for a blank file; a non-blank file
 *          that yields no chunks is the caller's error to raise.
 */
export function analyzeSourceFile(
  chunkers: SourceChunkers,
  file: { readonly relativePath: string; readonly kind: WorkspaceArtifactKind },
  content: string,
): AnalyzedSourceFile {
  const hash = crypto.createHash('md5').update(content).digest('hex');
  const analysis = file.kind === 'prisma-schema'
    ? chunkers.prisma.analyze(file.relativePath, content, hash)
    : chunkers.typescript.analyze(file.relativePath, content, hash);
  const chunks = splitChunksForEmbedding(
    analysis.chunks.map((chunk) => ({ ...chunk, filePath: file.relativePath } as StoredChunk)),
  ) as StoredChunk[];
  return {
    relativePath: file.relativePath,
    kind: file.kind,
    hash,
    skeleton: analysis.skeleton,
    chunks,
    dependencies: analysis.dependencies,
    nestGraph: file.kind === 'typescript' ? analyzeNestGraph(file.relativePath, content) : undefined,
    empty: content.trim().length === 0,
  };
}

/**
 * Writes an analysed, embedded file: registry row, chunks, vectors, dependency
 * edges and NestJS wiring, in one transaction.
 *
 * Inside an open transaction, better-sqlite3 runs this as a savepoint, so the
 * overlay's outer transaction still owns the outcome.
 *
 * @param db - Connection to write through.
 * @param identity - Embedding identity the vectors belong to.
 * @param file - The analysed file.
 * @param vectors - One vector per chunk, in chunk order.
 * @throws {Error} When the vectors do not match the chunks one for one.
 */
export function commitIndexedFile(
  db: Database.Database,
  identity: EmbeddingsIdentity,
  file: AnalyzedSourceFile,
  vectors: readonly (readonly number[])[],
): void {
  if (vectors.length !== file.chunks.length || vectors.some((vector) => vector.length === 0)) {
    throw new Error(`Embedding provider returned ${vectors.length} unusable vectors for ${file.chunks.length} chunks.`);
  }
  const insertChunk = db.prepare(`
    INSERT INTO code_chunks (id, file_path, chunk_type, content, metadata)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET file_path = excluded.file_path, chunk_type = excluded.chunk_type,
      content = excluded.content, metadata = excluded.metadata
  `);
  const insertVector = db.prepare(`
    INSERT INTO chunk_vectors (chunk_id, provider, model, dimensions, vector)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(chunk_id, provider, model) DO UPDATE SET dimensions = excluded.dimensions, vector = excluded.vector
  `);
  db.transaction(() => {
    writeRegistryRow(db, file, file.skeleton, 'indexed');
    for (let index = 0; index < file.chunks.length; index += 1) {
      const chunk = file.chunks[index]!;
      const vector = vectors[index]!;
      insertChunk.run(chunk.id, chunk.filePath, chunk.type, chunk.content, JSON.stringify(chunk.metadata));
      insertVector.run(chunk.id, identity.provider, identity.model, vector.length, encodeVector([...vector]));
    }
    // Nest wiring is replaced inside the same transaction as the chunks it
    // belongs to. Committed separately it could be half-applied, and a
    // binding row that outlives the file that declared it is the stale
    // confidence ADR-017 was written about.
    writeGraphRows(db, file);
  })();
}

/**
 * Writes a file's registry row and graph rows without chunks or vectors.
 *
 * Only a worktree overlay uses this, for the graph tools: they read edges and
 * NestJS wiring, never vectors, so answering them must not require an
 * embedding provider. Never committed by any caller.
 *
 * @param db - Connection to write through.
 * @param file - The analysed file.
 */
export function commitGraphOnlyFile(db: Database.Database, file: AnalyzedSourceFile): void {
  db.transaction(() => {
    writeRegistryRow(db, file, file.skeleton, 'indexed');
    writeGraphRows(db, file);
  })();
}

/**
 * Records an intentional zero-content omission, never an embedding failure.
 *
 * @param db - Connection to write through.
 * @param file - The file's identity and hash.
 * @param skeleton - Skeleton to store, if any.
 * @param reason - Why the file has no chunks.
 */
export function commitSkippedFile(
  db: Database.Database,
  file: { readonly relativePath: string; readonly hash: string },
  skeleton: object | null,
  reason: string,
): void {
  db.transaction(() => {
    writeRegistryRow(db, file, skeleton, 'skipped', reason);
  })();
}

/** The one statement that records a file in `file_registry`. */
function writeRegistryRow(
  db: Database.Database,
  file: { readonly relativePath: string; readonly hash: string },
  skeleton: object | null,
  state: 'indexed' | 'skipped',
  reason: string | null = null,
): void {
  db.prepare(`
    INSERT OR REPLACE INTO file_registry
      (path, hash, last_indexed, skeleton_signature, index_state, skip_reason)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(file.relativePath, file.hash, Date.now(), skeleton === null ? null : JSON.stringify(skeleton), state, reason);
}

/** Replaces a file's outgoing dependency edges and, for TypeScript, its NestJS wiring. */
function writeGraphRows(db: Database.Database, file: AnalyzedSourceFile): void {
  replaceDependencyGraphForFile(db, file.relativePath, file.dependencies, file.hash);
  if (file.nestGraph !== undefined) {
    replaceNestGraphForFile(db, file.relativePath, file.nestGraph, file.hash);
  }
}
