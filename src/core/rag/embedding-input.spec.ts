import {
  assertStoredInputsAreSafe,
  embeddingInputFor,
  MAX_EMBEDDING_INPUT_CHARACTERS,
  splitChunksForEmbedding,
} from './embedding-input';
import { ProcessedChunk } from '../types';

function chunk(content: string): ProcessedChunk {
  return {
    id: 'original',
    type: 'method',
    parentId: 'parent',
    filePath: 'src/example.ts',
    content,
    metadata: {
      startLine: 10,
      endLine: 20,
      className: 'ExampleService',
      methodName: 'work',
    },
  };
}

describe('embedding input boundaries', () => {
  it('keeps ordinary chunks intact and below the provider-safe ceiling', () => {
    const source = chunk('return result;');

    const result = splitChunksForEmbedding([source]);

    expect(result).toEqual([source]);
    expect(embeddingInputFor(result[0]!)).toContain('Method: work');
    expect(embeddingInputFor(result[0]!).length).toBeLessThan(MAX_EMBEDDING_INPUT_CHARACTERS);
  });

  it('splits oversized source without dropping or reordering characters', () => {
    const source = chunk(`${'first line\n'.repeat(1_000)}last line`);

    const result = splitChunksForEmbedding([source]);

    expect(result.length).toBeGreaterThan(1);
    expect(result.map((part) => part.content).join('')).toBe(source.content);
    expect(result[0]?.id).toBe('original');
    expect(result.every((part) => part.parentId === 'parent')).toBe(true);
    expect(result.map((part) => part.metadata.fragmentIndex)).toEqual(
      result.map((_, index) => index + 1),
    );
    expect(result.every((part) => part.metadata.fragmentCount === result.length)).toBe(true);
    expect(result.every((part) => embeddingInputFor(part).length <= MAX_EMBEDDING_INPUT_CHARACTERS)).toBe(true);
  });

  it('does not silently truncate legacy chunks during a provider backfill', () => {
    const source = chunk('x'.repeat(MAX_EMBEDDING_INPUT_CHARACTERS));

    expect(() => assertStoredInputsAreSafe([source])).toThrow('Rebuild the local .umbra index');
  });
});
