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
