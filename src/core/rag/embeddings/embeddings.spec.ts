import {
  EMBEDDING_VECTOR_COLUMNS,
  EmbeddingsIndexMismatchError,
  EmbeddingsPort,
} from './embeddings.port';
import { EMBEDDINGS_ENV_VAR, resolveEmbeddings } from './embeddings-resolver';
import { pinRuntimeRoot, resetRuntimeRoot } from '../../config/runtime-root';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * A stub port, so the resolver and the mismatch error can be tested without a
 * network call, credentials, or a running Ollama.
 *
 * @param provider - Provider to impersonate.
 * @returns A port that returns a fixed vector.
 */
function stubPort(provider: 'vertex' | 'ollama'): EmbeddingsPort {
  return {
    identity: {
      provider,
      model: provider === 'vertex' ? 'text-embedding-004' : 'nomic-embed-text',
      dimensions: 768,
      column: provider === 'vertex' ? 'vector_vertex_json' : 'vector_ollama_json',
    },
    embedQuery: async () => [1, 0, 0],
    embedDocuments: async (texts) => texts.map(() => [1, 0, 0]),
  };
}

describe('embedding identity', () => {
  it('gives each provider its own column, so vectors can never be mixed', () => {
    // Two models can return the same dimensions from unrelated vector spaces:
    // `nomic-embed-text` and `text-embedding-004` are both 768. A mixed cosine
    // similarity does not error, it returns a credible, meaningless score. The
    // column split is what makes that mistake unrepresentable.
    const vertex = stubPort('vertex').identity;
    const ollama = stubPort('ollama').identity;

    expect(vertex.column).not.toBe(ollama.column);
    expect(vertex.dimensions).toBe(ollama.dimensions);
  });

  it('keeps the column list and the provider list in one place', () => {
    // `AgentDB`'s migration reads this constant, so the schema cannot drift
    // away from the providers (ADR-018's rule applied to a set).
    expect([...EMBEDDING_VECTOR_COLUMNS]).toEqual(['vector_vertex_json', 'vector_ollama_json']);
  });
});

describe('EmbeddingsIndexMismatchError', () => {
  it('names what built the index and what is querying it', () => {
    const error = new EmbeddingsIndexMismatchError(stubPort('ollama').identity, ['vertex']);

    expect(error.message).toContain('vertex');
    expect(error.message).toContain('ollama/nomic-embed-text');
  });

  it('tells the operator what to run, not just that something is wrong', () => {
    // Returning zero results here would be a quieter lie: "no results" is
    // indistinguishable from "nothing matched your question".
    const error = new EmbeddingsIndexMismatchError(stubPort('ollama').identity, ['vertex']);

    expect(error.message).toMatch(/UMBRA_EMBEDDINGS=ollama/);
  });

  it('says so plainly when nothing is indexed at all', () => {
    const error = new EmbeddingsIndexMismatchError(stubPort('vertex').identity, []);

    expect(error.message).toContain('no provider');
  });
});

describe('embeddings resolution ladder', () => {
  const originalEnv = process.env[EMBEDDINGS_ENV_VAR];

  /**
   * Points the runtime root at an empty directory, so no project policy file
   * exists and the ladder really reaches the rung under test.
   *
   * Without this the suite read *this* repository's own
   * `.umbra/agent.config.json`, so "defaults to ollama" passed for the wrong
   * reason — it was resolving from `config`, not from `default`. A test that
   * depends on the machine it runs on is not testing the ladder.
   *
   * @returns Nothing.
   */
  function useEmptyProject(): void {
    resetRuntimeRoot();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-resolver-'));
    pinRuntimeRoot(dir);
  }

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[EMBEDDINGS_ENV_VAR];
    else process.env[EMBEDDINGS_ENV_VAR] = originalEnv;
    resetRuntimeRoot();
  });

  it('lets an explicit argument win, as ADR-002 fixed for models', () => {
    process.env[EMBEDDINGS_ENV_VAR] = 'vertex';

    const selection = resolveEmbeddings('ollama');

    expect(selection.source).toBe('argument');
    expect(selection.port.identity.provider).toBe('ollama');
  });

  it('honours the environment when no argument is given', () => {
    process.env[EMBEDDINGS_ENV_VAR] = 'ollama';

    const selection = resolveEmbeddings();

    expect(selection.source).toBe('environment');
    expect(selection.port.identity.provider).toBe('ollama');
  });

  it('reports an unrecognised value instead of silently defaulting', () => {
    // A typo that quietly changes which vector space is used is the class of
    // failure ADR-017 was written about.
    delete process.env[EMBEDDINGS_ENV_VAR];

    const selection = resolveEmbeddings('llama-something');

    expect(selection.ignoredValue).toBe('llama-something');
    // It still resolves to something usable rather than refusing to embed;
    // what matters is that the bad value is surfaced, not swallowed.
    expect(['vertex', 'ollama']).toContain(selection.port.identity.provider);
  });

  it('defaults to ollama, so a first install has free search with no credentials', () => {
    // Changed in 2.2.0 (ADR-027). Before that the default was `vertex`, which
    // meant a fresh install had no semantic search at all until someone set up
    // a Google Cloud project. Vertex is one config line away and nothing about
    // it was removed.
    delete process.env[EMBEDDINGS_ENV_VAR];
    useEmptyProject();

    const selection = resolveEmbeddings();

    expect(selection.port.identity.provider).toBe('ollama');
    expect(selection.source).toBe('default');
  });

  it('still lets an operator pick vertex explicitly', () => {
    delete process.env[EMBEDDINGS_ENV_VAR];
    useEmptyProject();

    expect(resolveEmbeddings('vertex').port.identity.provider).toBe('vertex');
    process.env[EMBEDDINGS_ENV_VAR] = 'vertex';
    expect(resolveEmbeddings().port.identity.provider).toBe('vertex');
  });
});
