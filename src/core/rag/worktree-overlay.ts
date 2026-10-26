import type Database from 'better-sqlite3';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { ResolvedWorktree } from '../config/git-worktrees';
import { NestChunker } from '../tools/ast/chunker';
import type { ChunkMetadata, ChunkType } from '../types';
import type { EmbeddingsIdentity, EmbeddingsPort } from './embeddings/embeddings.port';
import { embeddingInputFor } from './embedding-input';
import { EmbeddingCache } from './embedding-cache';
import { analyzeSourceFile, type AnalyzedSourceFile } from './indexed-file-rows';
import { PrismaSchemaChunker } from './prisma-schema-chunker';
import { decodeVector } from './vector-codec';
import { readRegularFileNoFollow, type WorktreeDelta } from './worktree-delta';

/**
 * A worktree's rows, ready to be stacked on the base index (ADR-038).
 *
 * The overlay is a cache, never state: it is rebuilt from git and the
 * worktree's files whenever its delta changes, and it is never written to
 * disk. What makes it cheap is that almost nothing in it needs a new
 * embedding. A file edited in one method still has every other chunk's input
 * unchanged, and the base index already holds a vector for each of those
 * inputs, at the same path. Cursor's indexer works the same way ("caches
 * embeddings by chunk content"); here the cache is the base index itself.
 */

/** One worktree file in the overlay. */
export interface OverlayFile {
  /** The file's rows, from the worktree's version of it. */
  readonly analyzed: AnalyzedSourceFile;
  /** One vector per chunk when the overlay was built for semantic search. */
  readonly vectors?: readonly (readonly number[])[];
}

/** What building an overlay cost. */
export interface OverlayBuildStats {
  /** Chunks across every overlay file. */
  readonly chunks: number;
  /** Chunks whose vector came from the base index or the process memo. */
  readonly reused: number;
  /** Chunks the provider embedded for this overlay. */
  readonly embedded: number;
  /** Wall time of the build, cache hits excluded. */
  readonly buildMs: number;
}

/** A worktree's departures from the base index, ready to stack. */
export interface WorktreeOverlay {
  /** The worktree it describes. */
  readonly worktree: ResolvedWorktree;
  /** The delta it was built from. */
  readonly delta: WorktreeDelta;
  /** Files present in the worktree whose rows replace the base's. */
  readonly files: readonly OverlayFile[];
  /** Whether every file carries vectors, so semantic search can run on it. */
  readonly embedded: boolean;
  /** Build cost; reused from the cached build on a cache hit. */
  readonly stats: OverlayBuildStats;
}

/** How many overlays one process keeps: one per active worktree is the expected shape. */
const MAX_CACHED_OVERLAYS = 16;

/** How many chunk vectors the process memo keeps across overlays. */
const MAX_MEMO_VECTORS = 20_000;

/** Same batch size the base indexer embeds with. */
const EMBED_BATCH_SIZE = 10;

/**
 * Builds and caches worktree overlays for one embedding identity.
 *
 * One instance per process: the cache and the memo are only useful shared.
 */
export class WorktreeOverlayBuilder {
  private readonly overlays = new Map<string, WorktreeOverlay>();

  /** Concurrent tool calls for one delta share a single build. */
  private readonly inflight = new Map<string, Promise<WorktreeOverlay>>();

  /** Kept as float32, the precision the index stores, at half the memory of a number array. */
  private readonly memo = new Map<string, Float32Array>();

  private readonly persistentCache: EmbeddingCache;

  /**
   * @param embeddings - Provider whose identity the overlay's vectors must share with the base index.
   * @param baseDb - The base index, read for reusable vectors.
   */
  public constructor(
    private readonly embeddings: EmbeddingsPort,
    private readonly baseDb: Database.Database,
  ) {
    this.persistentCache = new EmbeddingCache(baseDb);
  }

  /**
   * Returns the overlay for a delta, building only what the cache lacks.
   *
   * @param worktree - The worktree the delta belongs to.
   * @param delta - Its departures from the base index.
   * @param options - `embed: false` builds the graph rows only, for tools that read no vectors.
   * @returns The overlay.
   * @throws {Error} When the provider fails to embed a chunk the overlay needs.
   */
  public async build(
    worktree: ResolvedWorktree,
    delta: WorktreeDelta,
    options: { readonly embed: boolean },
  ): Promise<WorktreeOverlay> {
    const identity = this.embeddings.identity;
    const key = `${identity.provider}/${identity.model}/${identity.dimensions}\0${delta.signature}`;
    const cached = this.overlays.get(key);
    if (cached !== undefined && (cached.embedded || !options.embed)) {
      this.touch(key, cached);
      // Nothing was built for this call: every vector came from the cache.
      return { ...cached, stats: { chunks: cached.stats.chunks, reused: cached.embedded ? cached.stats.chunks : 0, embedded: 0, buildMs: 0 } };
    }

    // A graph-only read must never wait for a slow vector build.
    const pendingKey = `${key}\0${options.embed ? 'vectors' : 'graph'}`;
    const pending = this.inflight.get(pendingKey);
    if (pending !== undefined) {
      const result = await pending;
      if (result.embedded || !options.embed) {
        return { ...result, stats: { chunks: result.stats.chunks, reused: result.embedded ? result.stats.chunks : 0, embedded: 0, buildMs: 0 } };
      }
    }
    const build = this.buildFresh(worktree, delta, options, identity, key);
    this.inflight.set(pendingKey, build);
    try {
      return await build;
    } finally {
      if (this.inflight.get(pendingKey) === build) this.inflight.delete(pendingKey);
    }
  }

  /** Parses, embeds and records one uncached overlay. */
  private async buildFresh(
    worktree: ResolvedWorktree,
    delta: WorktreeDelta,
    options: { readonly embed: boolean },
    identity: EmbeddingsIdentity,
    key: string,
  ): Promise<WorktreeOverlay> {
    const cached = this.overlays.get(key);

    const startedAt = Date.now();
    const chunkers = { typescript: new NestChunker(delta.worktreeRoot), prisma: new PrismaSchemaChunker() };
    const analyzed = cached?.files.map((file) => file.analyzed) ?? delta.changed.map((file) => {
      const content = readRegularFileNoFollow(file.absolutePath);
      if (content === undefined) {
        throw new Error(`${file.worktreePath} stopped being a regular file while its worktree overlay was built; retry.`);
      }
      // Parsed in the worktree's own paths, so imports resolve against its
      // files, then moved to the index's paths (a submodule's prefix).
      return relocate(analyzeSourceFile(chunkers, { relativePath: file.worktreePath, kind: file.kind }, content), delta.indexPrefix);
    });

    let reused = 0;
    let embedded = 0;
    let files: OverlayFile[];
    if (options.embed) {
      files = [];
      for (const file of analyzed) {
        const outcome = await this.vectorsFor(file, identity);
        reused += outcome.reused;
        embedded += outcome.embedded;
        files.push({ analyzed: file, vectors: outcome.vectors });
      }
    } else {
      files = analyzed.map((file) => ({ analyzed: file }));
    }

    const overlay: WorktreeOverlay = {
      worktree,
      delta,
      files,
      embedded: options.embed,
      stats: {
        chunks: analyzed.reduce((total, file) => total + file.chunks.length, 0),
        reused,
        embedded,
        buildMs: Date.now() - startedAt,
      },
    };
    this.touch(key, overlay);
    return overlay;
  }

  /** Keeps the cache bounded, most recently used last. */
  private touch(key: string, overlay: WorktreeOverlay): void {
    this.overlays.delete(key);
    this.overlays.set(key, overlay);
    while (this.overlays.size > MAX_CACHED_OVERLAYS) {
      const oldest = this.overlays.keys().next().value;
      if (oldest === undefined) break;
      this.overlays.delete(oldest);
    }
  }

  /**
   * One vector per chunk, embedding only inputs neither the base index nor the
   * memo already has.
   */
  private async vectorsFor(
    file: AnalyzedSourceFile,
    identity: EmbeddingsIdentity,
  ): Promise<{ vectors: (readonly number[])[]; reused: number; embedded: number }> {
    const inputs = file.chunks.map((chunk) => embeddingInputFor(chunk));
    const keys = inputs.map((input) => memoKey(identity, input));
    const fromBase = this.baseVectorsByInput(file.relativePath, identity);
    const fromPersistent = this.persistentCache.get(identity, inputs);

    const vectors: (readonly number[] | undefined)[] = inputs.map((input, index) => {
      const known = this.memo.get(keys[index]!) ?? fromBase.get(input) ?? fromPersistent.get(input);
      if (known === undefined) return undefined;
      this.remember(keys[index]!, known instanceof Float32Array ? known : Float32Array.from(known));
      return Array.from(known);
    });
    const reused = vectors.filter((vector) => vector !== undefined).length;

    const missing = vectors.flatMap((vector, index) => (vector === undefined ? [index] : []));
    for (let start = 0; start < missing.length; start += EMBED_BATCH_SIZE) {
      const batch = missing.slice(start, start + EMBED_BATCH_SIZE);
      const result = await this.embeddings.embedDocuments(batch.map((index) => inputs[index]!));
      if (result.length !== batch.length || result.some((vector) => vector.length !== identity.dimensions)) {
        throw new Error(`Embedding provider returned incompatible vectors for ${batch.length} worktree chunks of ${file.relativePath}.`);
      }
      this.persistentCache.put(identity, batch.map((index) => inputs[index]!), result);
      batch.forEach((index, position) => {
        vectors[index] = result[position]!;
        this.remember(keys[index]!, Float32Array.from(result[position]!));
      });
    }

    return { vectors: vectors as (readonly number[])[], reused, embedded: missing.length };
  }

  /** The base index's vectors for one path, keyed by the exact text each was embedded from. */
  private baseVectorsByInput(relativePath: string, identity: EmbeddingsIdentity): Map<string, Float32Array> {
    const rows = this.baseDb.prepare(`
      SELECT c.id, c.chunk_type, c.content, c.metadata, v.vector
        FROM code_chunks c
        JOIN chunk_vectors v ON v.chunk_id = c.id AND v.provider = ? AND v.model = ? AND v.dimensions = ?
       WHERE c.file_path = ?
    `).all(identity.provider, identity.model, identity.dimensions, relativePath) as Array<{
      id: string; chunk_type: ChunkType; content: string; metadata: string; vector: Buffer;
    }>;
    const byInput = new Map<string, Float32Array>();
    for (const row of rows) {
      let metadata: ChunkMetadata;
      try {
        metadata = JSON.parse(row.metadata) as ChunkMetadata;
      } catch {
        continue;
      }
      byInput.set(
        embeddingInputFor({ id: row.id, type: row.chunk_type, content: row.content, metadata }),
        decodeVector(row.vector),
      );
    }
    return byInput;
  }

  /** Records a vector in the bounded memo. */
  private remember(key: string, vector: Float32Array): void {
    this.memo.delete(key);
    this.memo.set(key, vector);
    while (this.memo.size > MAX_MEMO_VECTORS) {
      const oldest = this.memo.keys().next().value;
      if (oldest === undefined) break;
      this.memo.delete(oldest);
    }
  }
}

/**
 * Moves an analysed file from the worktree's paths to the index's.
 *
 * @param file - Rows parsed with worktree-relative paths.
 * @param prefix - Where the worktree's repository sits in the index; `''` changes nothing.
 * @returns The same rows under index paths.
 */
export function relocate(file: AnalyzedSourceFile, prefix: string): AnalyzedSourceFile {
  if (prefix === '') return file;
  const toIndex = (worktreePath: string): string => path.posix.normalize(`${prefix}/${worktreePath}`);
  return {
    ...file,
    relativePath: toIndex(file.relativePath),
    chunks: file.chunks.map((chunk) => ({ ...chunk, filePath: toIndex(chunk.filePath) })),
    dependencies: file.dependencies.map((edge) => ({
      ...edge,
      sourcePath: toIndex(edge.sourcePath),
      targetPath: toIndex(edge.targetPath),
    })),
  };
}

/** A vector is reusable exactly when the identity and the embedded text are equal. */
function memoKey(identity: EmbeddingsIdentity, input: string): string {
  return crypto.createHash('sha256').update(identity.provider).update('\0').update(identity.model).update('\0').update(String(identity.dimensions)).update('\0').update(input).digest('hex');
}
