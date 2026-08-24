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
