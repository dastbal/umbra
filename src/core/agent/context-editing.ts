import { ClearToolUsesEdit, contextEditingMiddleware } from 'langchain';

/**
 * @module ContextEditing
 *
 * Keeps a long conversation from paying for its whole history on every call.
 *
 * ## The cost it removes
 *
 * Every tool result stays in the thread, so every later model call sends it
 * again. Measured with `npm run bench:context-growth` on the default
 * configuration, six turns that read two real files each grew the input of the
 * last call to 74,471 tokens, and the eighteen calls of that conversation sent
 * 727,225 input tokens between them. The growth is linear per call and never
 * stops: each file read adds about 6,170 tokens to every call that follows.
 *
 * ## What it replaces
 *
 * `ChatSession#checkAndCompressContext` answered the same problem by asking a
 * model for a summary and sending it back into the same thread with
 * `sendMessage`. That cost at least two extra model calls — the summary, and a
 * full turn to acknowledge it with the entire history attached — and removed
 * nothing: the thread grew by the summary and the acknowledgement. This clears
 * old tool results inside the model call instead. No model is asked anything.
 *
 * ## How it behaves, read from the installed `ClearToolUsesEdit`
 *
 * When the request reaches `triggerTokens`, every tool result except the
 * `keepToolResults` most recent is replaced by `[cleared]`; the call that made
 * it stays, so the model still knows what it read and when. The result is a
 * sawtooth rather than a slope. The edit marks what it cleared and never clears
 * it twice, and it removes orphaned tool results even below the trigger — a
 * no-op on a well-formed thread.
 *
 * ## Why these numbers
 *
 * - `keepToolResults: 3` — the deep prompt sizes a small task at three tool
 *   calls, so a small task is never cleared out from under itself.
 * - `triggerTokens: 40_000` — after a clear, the floor plus three reads sits
 *   near 22,300 tokens on the measured configuration. A trigger below roughly
 *   28,500 would clear after every read; 40,000 leaves room for about three
 *   reads between clears. It is half the 80,000 the old compressor waited for,
 *   and far below the window of every hosted model Umbra routes to, so it acts
 *   long before the summarization deepagents keeps at 85% of the window — which
 *   stays as the backstop.
 * - `excludeTools` — the orchestration guard counts each role's results by
 *   reading the thread (`readDelegationArtifacts`), so a delegation's result is
 *   never cleared, nor the question a delegate asked.
 *
 * Token counting stays on the library default, `"approx"`: the `"model"` method
 * exists only for OpenAI models and throws on Gemini and Claude.
 */

/**
 * The editing policy, read when the middleware is built.
 *
 * Mutable on purpose, and only for one reader: `bench-context-growth.mjs` moves
 * the trigger out of reach to run its control arm on the same agent. Nothing in
 * `src/` writes it.
 */
export const CONTEXT_EDITING = {
  triggerTokens: 40_000,
  keepToolResults: 3,
  excludeTools: ['delegate', 'ask_delegator'] as string[],
};

/**
 * Builds the context-editing middleware for a root agent.
 *
 * @returns Middleware for the deep, orchestrator and MCP-advisor `middleware`
 * arrays. The one-shot analysis agent has no history to grow and does not get it.
 */
export function createContextEditingMiddleware() {
  return contextEditingMiddleware({
    edits: [new ClearToolUsesEdit({
      trigger: { tokens: CONTEXT_EDITING.triggerTokens },
      keep: { messages: CONTEXT_EDITING.keepToolResults },
      excludeTools: [...CONTEXT_EDITING.excludeTools],
    })],
  });
}
