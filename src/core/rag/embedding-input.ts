import { randomUUID } from 'node:crypto';
import { ProcessedChunk } from '../types';

/**
 * Conservative character ceiling for embedding input across the supported
 * providers. It keeps code well below nomic-embed-text's 2K-token limit while
 * preserving all source in stored fragments.
 */
export const MAX_EMBEDDING_INPUT_CHARACTERS = 1_500;

const MAX_EMBEDDING_DOCUMENTATION_CHARACTERS = 512;

/**
 * Builds the exact text sent to an embedding provider without changing the
 * source stored in SQLite.
 *
 * @param chunk - Source fragment to represent semantically.
 * @returns Bounded metadata followed by the complete fragment content.
 */
export function embeddingInputFor(chunk: ProcessedChunk): string {
  const symbol = chunk.metadata.methodName === undefined
    ? `Class: ${chunk.metadata.className ?? 'unknown'}`
    : `Method: ${chunk.metadata.methodName}`;
  const documentation = chunk.metadata.documentation;
  const boundedDocumentation = documentation === undefined
    ? ''
    : `TSDoc:\n${documentation.slice(0, MAX_EMBEDDING_DOCUMENTATION_CHARACTERS)}\n`;
  return `${symbol}\n${boundedDocumentation}${chunk.content}`;
}

/**
 * Splits source units before they are stored so every persisted chunk can be
 * embedded by the smallest supported local model. No code is discarded: only
 * the unit boundaries change.
 *
 * The first fragment retains the original id. Child method chunks can therefore
 * keep referring to a split class-signature chunk through their existing
 * parentId.
 *
 * @param chunks - Chunks emitted by the AST chunker.
 * @returns The original chunks or lossless, line-aware fragments.
 */
export function splitChunksForEmbedding(chunks: readonly ProcessedChunk[]): ProcessedChunk[] {
  return chunks.flatMap((chunk) => splitChunkForEmbedding(chunk));
}

/**
 * Splits one AST chunk at newline boundaries, falling back to character
 * boundaries for generated or minified single-line files.
 *
 * @param chunk - Source unit to inspect.
 * @returns One or more safe fragments.
 */
export function splitChunkForEmbedding(chunk: ProcessedChunk): ProcessedChunk[] {
  const prefixLength = embeddingInputFor({ ...chunk, content: '' }).length;
  const contentLimit = Math.max(256, MAX_EMBEDDING_INPUT_CHARACTERS - prefixLength);
  if (chunk.content.length <= contentLimit) return [chunk];

  const pieces = splitContent(chunk.content, contentLimit);
  let consumedLines = 0;

  return pieces.map((content, index) => {
    const lineCount = newlineCount(content);
    const startLine = chunk.metadata.startLine + consumedLines;
    consumedLines += lineCount;
    return {
      ...chunk,
      id: index === 0 ? chunk.id : randomUUID(),
      content,
      metadata: {
        ...chunk.metadata,
        startLine,
        endLine: Math.max(startLine, startLine + lineCount),
        fragmentIndex: index + 1,
        fragmentCount: pieces.length,
      },
    };
  });
}

/**
 * Refuses to send an old, oversized stored chunk to a provider. Existing
 * indexes must be rebuilt into fragments instead of silently truncating source
 * during a provider backfill.
 *
 * @param chunks - Stored chunks about to be backfilled.
 * @returns Nothing when every input is safe.
 * @throws When a previous index needs a clean rebuild.
 */
export function assertStoredInputsAreSafe(chunks: readonly ProcessedChunk[]): void {
  const oversized = chunks.filter((chunk) => embeddingInputFor(chunk).length > MAX_EMBEDDING_INPUT_CHARACTERS);
  if (oversized.length === 0) return;

  throw new Error(
    `${oversized.length} stored code chunk(s) exceed the safe embedding limit. ` +
      'Rebuild the local .umbra index so Umbra can store lossless fragments before switching providers.',
  );
}

/** Splits text without dropping delimiters or changing source order. */
function splitContent(content: string, limit: number): string[] {
  const pieces: string[] = [];
  let current = '';

  for (const line of content.split(/(?<=\n)/u)) {
    if (line.length > limit) {
      if (current.length > 0) {
        pieces.push(current);
        current = '';
      }
      for (let offset = 0; offset < line.length; offset += limit) {
        pieces.push(line.slice(offset, offset + limit));
      }
      continue;
    }
    if (current.length > 0 && current.length + line.length > limit) {
      pieces.push(current);
      current = line;
    } else {
      current += line;
    }
  }

  if (current.length > 0) pieces.push(current);
  return pieces;
}

/** Counts source line separators without normalising the source text. */
function newlineCount(value: string): number {
  return (value.match(/\n/gu) ?? []).length;
}
