# ADR-037 — Context editing replaces the appended summary

| | |
|---|---|
| **Category** | Agent runtime · Context budget · Cost |
| **Author** | David Balladares (decision) · Claude (implementation) |
| **Date** | 2026-09-23 |
| **Status** | ✅ **Accepted** |

## Context

Every tool result stays in a LangGraph thread, and every later model call sends
it again. A session that reads files therefore pays for its whole history each
time the model is asked anything.

Measured with `npm run bench:context-growth` on the default configuration
(`gemini-2.5-flash-lite`, `cl100k_base`), six user turns that read two real
repository files each grew the input of the last call to **74,457 tokens**, and
the eighteen calls of that conversation sent **726,993 input tokens** between
them. The growth is linear per call and never stops: each file read adds about
6,170 tokens to every call that follows.

Umbra's answer until now was `ChatSession#checkAndCompressContext`. After each
turn it asked `ContextCompressor.isOverBudget` whether the history had crossed
80,000 tokens; if so, it asked a model for a summary and sent that summary back
into **the same thread** with `sendMessage`, asking the agent to acknowledge it.
That cost at least two extra model calls — the summary, and a full turn with the
entire history attached — and removed nothing: the thread grew by the summary and
the acknowledgement, and the trigger re-armed ten messages later.

No record covered compression. `context-compressor.ts` cited ADR-007 for not
using a summarization middleware; ADR-007 never mentions summarization.

## Decision

Stale tool results are cleared inside the model call by
`createContextEditingMiddleware` in `src/core/agent/context-editing.ts`, which
wraps langchain's `contextEditingMiddleware` with one `ClearToolUsesEdit`:

- **`triggerTokens: 40_000`.** Once a request reaches it, every tool result
  except the most recent `keepToolResults` is replaced by `[cleared]`. The call
  that produced each result stays in the thread, so the model still knows what
  it read and when. No model is asked anything.
- **`keepToolResults: 3`.** The deep prompt sizes a small task at three tool
  calls, so a small task is never cleared out from under itself.
- **`excludeTools: ['delegate', 'ask_delegator']`.** The orchestration guard
  counts each role's results by reading the thread (`readDelegationArtifacts`),
  so a delegation's result, and a delegate's question, are never cleared.
- **Token counting on the library default, `"approx"`.** The `"model"` method
  exists only for OpenAI models and throws on Gemini and Claude.

The trigger was chosen from the measurement and from the installed algorithm,
read before choosing: `ClearToolUsesEdit#apply` clears all but `keep` when
triggered, so the history follows a sawtooth. After a clear, the floor plus three
reads sits near 22,300 tokens, so any trigger under about 28,500 would clear
after every single read. 40,000 leaves room for about three reads between clears,
is half what the old compressor waited for, and sits far below the window of
every hosted model Umbra routes to — well before the summarization middleware
deepagents installs at 85% of the window, which stays as the backstop.

It is installed first-after-the-todo-list in the deep agent, the orchestrator,
and the MCP advisor (which persists conversations), ahead of the turn governor,
so what the governor accounts is what is actually sent. It is not installed in
the one-shot analysis agent, which has no history to grow.

`ChatSession#checkAndCompressContext` is removed. `ContextCompressor` is not:
`/model` still uses `compress` to hand a summary from one agent to a new one,
which is what the module's header always said it was for. Its `isOverBudget` and
`estimateTokens` are removed with their only caller.

### Alternatives actually weighed

| Option | For | Against | Decision |
|---|---|---|---|
| Keep the appended summary | Already built | Two extra model calls per trigger, one of them a full-history turn; removes nothing | Rejected |
| Rely on deepagents' summarization alone | Already installed, nothing to write | Fires at 85% of the window: 850,000 tokens on the default Gemini model, so the history grows unbounded long before | Kept as the backstop, not as the mechanism |
| Add a second summarization middleware with an earlier trigger | Compacts human and AI turns too | A model call per trigger; a second instance of a middleware deepagents already installs | Rejected |
| **`contextEditingMiddleware` + `ClearToolUsesEdit`** | No model call; bounds exactly the part that grows; library-native | Old tool output is gone from the thread for good | **Chosen** |

## Consequences

**Positive**

- On the measured conversation the last call falls from 74,457 to 37,592
  tokens, and the conversation from 726,993 to 450,428 input tokens (−38%).
- The peak is bounded by the trigger however long the conversation runs. On
  the control arm the per-call input keeps rising; on the shipped arm it
  oscillates between about 22,000 and 40,000.
- Two model calls per trigger disappear, and so does 229 lines of code.

**Neutral**

- `ClearToolUsesEdit` also removes orphaned tool results — a tool message with
  no matching call — on every request, triggered or not. On a well-formed
  thread that does nothing.
- Measured with a six-turn conversation; the saving grows with length because
  the control grows linearly per call and the shipped arm does not.

**Negative**

- Clearing edits the thread's messages in place, so the original output of a
  cleared call is gone from the checkpoint. The model can read the file again;
  it cannot recover the old result. Accepted: that is the point.
- A cleared `ToolMessage` loses its `artifact` (ADR-032). Nothing reads an
  artifact from history — the CLI renders it from the live `on_tool_end` event
  — so this was checked and accepted.
- With a Claude model, the call on which a clear happens misses the prompt
  cache, because the prefix changed. A one-off cost per clear.
- `ContextCompressor.compress` had no test before this change and still has
  none.
- `recordSessionOverhead` keeps recording, but its only production reader was
  `estimateTokens`. It is now read only by `bench-turn-floor.mjs`. Recorded in
  `docs/deferred-work.md`.
- `DeepAgentFactoryConfig.enableContextCompression` never had an effect and is
  deprecated, not removed: the interface is exported, and removing a field would
  break a consumer that still passes it.

## Verification evidence

- `npm run bench:context-growth -- --arm off` and `-- --arm on`, both on
  `e7691f7` with a clean tree, reports under `docs/benchmarks/results/`: the
  figures above. On the shipped arm the first clear happens at call 9, dropping
  the input from what would have been 40,805 to 22,357 tokens — within 57 tokens
  of the 22,300 predicted from reading `ClearToolUsesEdit#apply`.
- `npm run bench:floor`: the deep agent's first call stays at 3,827 tokens.
  Context editing adds no tool and no prompt text.
- `src/core/agent/context-editing.spec.ts`, against a real `createAgent` with
  the real policy — no lowered trigger, no mocked library: nothing is cleared
  under the trigger; above it every result but the three most recent is; the
  payload stays bounded; `delegate` and `ask_delegator` results are never
  cleared.
- Unit suite 1,062 passed, contracts 34 passed. The one failure,
  `retrieval-gate.spec.ts`, predates this change and touches none of its modules.

## Related files

- `src/core/agent/context-editing.ts` — `CONTEXT_EDITING`, `createContextEditingMiddleware`
- `src/core/agent/context-editing.spec.ts`
- `src/core/agent/deep-agent-factory.ts` — `DeepAgentFactory#create`, `#createOrchestrator`, `#createMcpAdvisor`; `DeepAgentFactoryConfig.enableContextCompression` (deprecated)
- `src/presentation/cli/chat-session.ts` — ~~`ChatSession#checkAndCompressContext`~~ (removed); `ChatSession#handleModelSwitch` still uses `ContextCompressor.compress`
- `src/core/agent/context-compressor.ts` — `ContextCompressor.compress`; ~~`isOverBudget`~~, ~~`estimateTokens`~~ (removed)
- `src/core/agent/session-overhead.ts` — `recordSessionOverhead`, `sessionOverhead` (no production reader)
- `scripts/bench-context-growth.mjs` — `npm run bench:context-growth`
- `src/presentation/cli/module-size-ceiling.spec.ts` — `CEILINGS` (chat-session lowered to 1,292)
