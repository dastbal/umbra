import { OllamaChatAdapter } from './ollama-adapter';

/**
 * Guards the lookup hint that lets deepagents find Umbra's Ollama harness
 * profile.
 *
 * ## What this covers, and what it deliberately does not
 *
 * `deepagents` is not imported here: pulling it in drags
 * `@langchain/langgraph-sdk` through Jest's CommonJS interop and the module
 * fails to load. So this spec asserts the two properties of the hint that
 * Umbra owns and that deepagents' resolution depends on — and nothing about
 * the library's behaviour, which was verified directly against
 * `getHarnessProfile` on 2026-08-28 and is recorded in ADR-017.
 *
 * The two properties, from deepagents' `getHarnessProfile`:
 *
 * 1. The hint must carry a colon, because the identifier branch of resolution
 *    is only taken for an identifier containing one — `ChatOllama` is absent
 *    from deepagents' three-entry provider map, so the provider branch is
 *    never reached for this adapter.
 * 2. The hint must have exactly two colon-separated parts, because a spec with
 *    more is rejected before the provider key is ever consulted.
 *
 * Break either and every Ollama exclusion is silently discarded, which is the
 * defect this guards: deepagents' built-in `ls` stayed live, read its in-memory
 * `StateBackend` rather than the disk, and told the model the project was empty.
 */
describe('OllamaChatAdapter harness lookup hint', () => {
  it.each([
    ['gemma4', 'ollama:gemma4'],
    ['gemma4:e2b', 'ollama:gemma4-e2b'],
    ['gemma4:26b', 'ollama:gemma4-26b'],
    ['qwen3.6:4b', 'ollama:qwen3.6-4b'],
    ['llama3.2:latest', 'ollama:llama3.2-latest'],
  ])('maps %s to the resolvable hint %s', (tag, expected) => {
    expect(new OllamaChatAdapter({ model: tag }).modelName).toBe(expected);
  });

  it.each(['gemma4', 'gemma4:e2b', 'gemma4:26b', 'qwen3.6:4b', 'llama3.2:latest'])(
    'keeps the hint for %s to exactly two colon-separated parts',
    (tag) => {
      const hint = new OllamaChatAdapter({ model: tag }).modelName;

      expect(hint.split(':')).toHaveLength(2);
      expect(hint.startsWith('ollama:')).toBe(true);
    },
  );

  it('leaves the real model name untouched for the Ollama API', () => {
    // The hint exists for profile lookup only. Sending `gemma4-e2b` to Ollama
    // would request a model that does not exist.
    expect(new OllamaChatAdapter({ model: 'gemma4:e2b' }).model).toBe('gemma4:e2b');
  });
});
