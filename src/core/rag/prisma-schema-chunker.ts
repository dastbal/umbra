import { randomUUID } from 'node:crypto';

import { FileAnalysisResult, ProcessedChunk } from '../types';

/** Extracts searchable, labelled business constraints from Prisma's authoritative schema. */
export class PrismaSchemaChunker {
  /**
   * Splits a Prisma schema into model- and enum-level configuration chunks.
   *
   * A full Prisma parser would add a second compiler to the package for no
   * retrieval benefit here: the preserved source text remains authoritative,
   * while line-bounded blocks make constraints such as `@unique` discoverable.
   *
   * @param filePath - Root-relative Prisma schema path.
   * @param content - Raw Prisma schema text.
   * @param fileHash - File registry identity already calculated by the indexer.
   * @returns Chunks and a compact schema skeleton without TypeScript graph edges.
   */
  public analyze(filePath: string, content: string, fileHash: string): FileAnalysisResult {
    const blocks = this.modelBlocks(content);
    const chunks = blocks.length === 0
      ? this.fallbackChunk(content)
      : blocks.map((block) => ({
        id: randomUUID(),
        type: 'config' as const,
        content: block.content,
        metadata: {
          startLine: block.startLine,
          endLine: block.endLine,
          className: block.name,
          artifactKind: 'prisma-schema' as const,
        },
      }));

    return {
      filePath,
      fileHash,
      chunks,
      dependencies: [],
      skeleton: {
        type: 'prisma-schema',
        models: blocks.map((block) => block.name),
      },
    };
  }

  /** Finds complete `model` and `enum` blocks without interpreting their fields. */
  private modelBlocks(content: string): Array<{ name: string; content: string; startLine: number; endLine: number }> {
    const lines = content.split(/(?<=\n)/u);
    const blocks: Array<{ name: string; content: string; startLine: number; endLine: number }> = [];
    let active: { name: string; startLine: number; depth: number; lines: string[] } | undefined;

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (active === undefined) {
        const header = line.match(/^\s*(?:model|enum)\s+([A-Za-z][A-Za-z0-9_]*)\s*\{/u);
        if (header === null) continue;
        active = {
          name: header[1]!,
          startLine: index + 1,
          depth: braceDelta(line),
          lines: [line],
        };
      } else {
        active.lines.push(line);
        active.depth += braceDelta(line);
      }

      if (active !== undefined && active.depth === 0) {
        blocks.push({
          name: active.name,
          content: active.lines.join(''),
          startLine: active.startLine,
          endLine: index + 1,
        });
        active = undefined;
      }
    }

    return blocks;
  }

  /** Keeps datasource-only schemas visible instead of creating a false empty-index state. */
  private fallbackChunk(content: string): ProcessedChunk[] {
    if (content.trim().length === 0) return [];
    return [{
      id: randomUUID(),
      type: 'config',
      content,
      metadata: {
        startLine: 1,
        endLine: Math.max(1, content.endsWith('\n') ? content.split('\n').length - 1 : content.split('\n').length),
        artifactKind: 'prisma-schema',
      },
    }];
  }
}

/** Counts braces while ignoring no source: Prisma model syntax is line-oriented and preserved verbatim. */
function braceDelta(line: string): number {
  return (line.match(/\{/gu) ?? []).length - (line.match(/\}/gu) ?? []).length;
}
