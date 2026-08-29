# ADR-006: Use non-streaming Vertex transport for tool cycles

## Status

Accepted — 2026-08-24

## Context

The interactive CLI consumes LangGraph `streamEvents()`. With Gemini 3.5, a
tool call completed but the next Vertex request failed with HTTP 400. The same
model, credentials, tool, and prompt completed through `agent.invoke()`.

The installed LangChain Vertex streaming path aggregates the model chunks before
the tool result is returned. That path does not retain the exact association
required by Gemini's tool-call thought signature, while the non-streaming path
does. The failure is independent of session recovery and credentials.

## Decision

`VertexChatAdapter` sets `disableStreaming = true`. LangChain therefore uses a
complete `invoke()` response internally even when the CLI consumes
`streamEvents()`. The CLI still displays the response through the same event
interface, but receives it as a completed response instead of incremental
tokens.

## Alternatives considered

- Continue streaming and patch the private LangChain chunk aggregation path.
  Rejected because it is dependency-internal and cannot be safely maintained
  without an upstream-compatible implementation and integration tests.
- Change credentials, model, or tool schemas. Rejected because the controlled
  non-streaming tool cycle succeeds with the same configuration.

## Validation

A fresh Deep agent reproduces the error through `streamEvents()` before this
decision and completes the same read-only tool cycle through `invoke()`. The
post-change validation must exercise `streamEvents()` with `list_files`, plus
TypeScript and the full Jest suite.

## Consequences

Vertex-backed CLI responses are delivered as complete messages, not incremental
tokens. Tool cycles remain reliable and session checkpoints receive valid
assistant completion messages.

---

## Amendment — 2026-08-26

`disableStreaming = true` did not eliminate the 400 on tool cycles. The original
text stands as the reasoning that was correct at the time; this records what was
later observed.

A `umbra deep` session on `gemini-3.5-flash` still fails with
`Google request failed with status code 400` on the turn *after* a successful
tool call. The rejected history, read from the trace:

```
[SystemMessage 13281 chars]
[HumanMessage    112 chars]
[AIMessageChunk    0 chars, 1 tool_call]   ← carries "signatures":["AY89a184I9CT…"]
[ToolMessage     618 chars]
```

Three things are known and worth not re-deriving:

- The called function (`list_files`) **was** declared, so this is unrelated to the
  undeclared-`task` defect of
  [ADR-013](./ADR-013-subagent-tool-exclusion-and-provider-diagnostics.md).
- The history carries Gemini 3.x **thought signatures**, the same mechanism this
  ADR's decision was written to protect.
- It is not the model: in the same window `gemini-3.5-flash` shows 11 successful
  calls and 0 failures. The failure is intermittent.

**The cause remains open.** ADR-013 deliberately instruments rather than patches:
a rejected request is now captured, redacted, under `.agent/diagnostics/`, and
trace batches are flushed before the process exits — without which the failing
sessions left no trace to read, which is why this went undiagnosed for a day.

Related files added by the amendment:

- `src/presentation/cli/provider-diagnostics.ts` — `extractProviderDiagnostic`.
- `src/core/observability/trace-flush.ts` — `flushPendingTraces`.

---

## Amendment — 2026-08-28: the consequence this record did not name

The Consequences section above says Vertex responses arrive "as complete
messages, not incremental tokens", and stops there. That is true and it is not
the whole cost. The rest surfaced today, as an operator watching the agent
deliberate with itself on screen.

### What was observed

Asked `hola, quien sos?`, `umbra deep` on `gemini-2.5-flash-lite` printed a
paragraph of the model reasoning about its own CONVERSATION GATE, and then the
greeting glued onto the end with no separator. A repair had already shipped for
this the same day — `readVisibleText`, which drops reasoning blocks — and it did
not hold.

### Why the repair did not hold

Reproduced live against Vertex, on the real Deep agent. The same model call
delivers its content twice, in two different shapes:

| Event | `content` | Separable? |
|---|---|---|
| `on_chat_model_stream` | `"Okay, so the user started with \"hola.\" My internal protocol, the CONVERSATION GATE…Hola, soy un agente de IA"` | **No** — one flat string |
| `on_chat_model_end` | `[{ type: 'reasoning', … }, { type: 'text', … }]` | Yes |

The CLI renders from the first and only counts tokens from the second.

The flat string is this ADR's own decision, arriving where nobody looked for it.
`disableStreaming = true` sends every turn down `@langchain/google-common`'s
non-streaming `_generate`, which ends:

```js
const chunk = ret?.generations?.[0];
if (chunk) await runManager?.handleLLMNewToken(chunk.text || '');
```

— `chat_models.cjs:167`. It emits the generation's **flat text** and passes no
structured chunk beside it, so LangChain's event tracer has nothing to rebuild
from and synthesises the turn's single `on_chat_model_stream` out of that raw
string. The reasoning is in it because `@langchain/google-common` derives
`includeThoughts` from the thinking budget (`utils/gemini.js`:896), which
`AGENT_REASONING=low` sets — the `forced-on` display already recorded in
[ADR-016](./ADR-016-one-reasoning-vocabulary-across-providers.md).

So the first repair was aimed correctly and stationed at the wrong door.
`readVisibleText` can separate blocks; nothing can un-fuse a string.

### Amendment

`VertexChatAdapter._generate` now silences the library's own token emission for
the call — through a prototype delegate, so every other callback still reaches
the real run manager — and emits the visible half in its place, taken from the
structured message before the fusion happens.

The returned `ChatResult` is **not** modified. The reasoning stays in the
message, so `on_chat_model_end`, the checkpointer, the trace and the token
accounting still see exactly what the provider returned. Only what is rendered
as it arrives changes.

`readVisibleText` moves from `src/presentation/cli/` to `src/core/llm/`, because
it is now read by two layers rather than one, and stays in place as the second
line of defence for providers that do stream blocks.

### Alternative considered and rejected

Forcing `includeThoughts: false` would also work and would cost less: the
thoughts would never be generated. It was rejected because that flag rides in
the same `thinkingConfig` as the thought signatures whose loss is the entire
reason this ADR exists, and this repository has already spent two days on that
failure. Suppressing the *display* cannot break a tool cycle; suppressing the
*request* might. The option is recorded rather than taken, and remains open if
the reasoning tokens ever need to stop being billed.

### Validation

Live against Vertex, `gemini-2.5-flash-lite`, `AGENT_REASONING=low`:

- A conversational turn prints only the answer; `on_chat_model_end` still
  carries its `reasoning` block.
- A `list_files` tool cycle completes across two model calls, with no reasoning
  in the rendered text — the cycle this ADR protects is unaffected.
- 66 suites, 656 tests. `tsc --noEmit` clean. `dist/` rebuilt, per the
  [ADR-012](./ADR-012-arrow-key-selection-prompts.md) amendment that a CLI
  change is not verified until it is.

Related files:

- `src/core/llm/vertex-chat-adapter.ts` — `_generate`, `withoutTokenEmission`.
- `src/core/llm/visible-text.ts` — moved from `src/presentation/cli/`.

### What the hidden reasoning costs, measured rather than estimated

The amendment above rejected `includeThoughts: false` on risk grounds and left
the cost question open. It is no longer open, because the cost is now readable.

Vertex reports the split in `usage_metadata`, and LangChain normalizes it to
`output_token_details.reasoning`. Measured live on `gemini-2.5-flash-lite` with
`AGENT_REASONING=low`, one ordinary question:

```
output_tokens: 670
output_token_details: { text: 69, reasoning: 601 }
```

**Nine of every ten completion tokens on that turn were deliberation the
operator never sees.** One call is not a distribution — a tool-driven turn
spends far more of its output on tool arguments — but it is large enough that
the decision deserves real data rather than a guess, which is why the split is
now recorded per turn instead of being sampled once here.

`readUsage` reads the share, `TurnSpend` carries it as a **subset** of the
completion tokens (never added to them, which would double-count the turn and
could trip the token ceiling on spend that never happened), the turn line prints
it beside the total, and `interactive-turns.jsonl` keeps `reasoningTokens` and
`reasoningCostUsd` per turn. `umbra metrics` sums both — along with `costUsd`,
which the file had carried since [ADR-019](./ADR-019-turn-cost-is-the-bound-not-tool-calls.md)
and this summary had never added up.

`turnsReportingReasoning` is published beside the sums as the sample size:
`@langchain/anthropic` publishes no breakdown in the installed version, so a
Claude session reports zero from *silence*, and a zero with no sample beside it
would read as a model that did not think.

Nothing about the request changed. This measures; it does not yet decide.

### The error that had nowhere to be read

The same session died with `Cannot read properties of undefined (reading
'message')` at `MiddlewareError.wrap`, and that told nobody anything.
`MiddlewareError` copies its cause's message onto itself (`errors.cjs`:54) and
keeps the original in `cause` (`errors.cjs`:57), so its own stack begins where
the wrapping happened — inside LangChain — while the code that failed sat one
level down and was never printed. The CLI read only `error.stack`.

`describeErrorOrigin` (`src/presentation/cli/error-origin.ts`) walks the `cause`
chain to its end and reports the deepest frame, skipping the wrapper's own. A
chain that offers nothing yields no detail line at all, rather than a frame from
the reporting machinery: an unhelpful line reads as an answer.

The frame is printed and **not** written to `interactive-turns.jsonl`. That file
hashes thread ids so it stays safe to hand to someone else, and a local stack
frame carries a filesystem path with the operator's username in it.

The underlying defect — whichever middleware read `.message` on `undefined` —
remains **unfound**. It could not be reproduced, and the session that hit it
left no trace. What changed is that the next occurrence will name itself.
