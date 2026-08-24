# ADR-005: Recover named sessions interrupted after a tool result

## Status

Accepted — 2026-08-24

## Context

An interactive `deep` session can be interrupted after a read-only tool has
completed but before Vertex AI returns its follow-up assistant message. The
persisted LangGraph checkpoint then ends with a `ToolMessage`. Appending a new
human message to that sequence causes Vertex AI to reject the conversation with
an HTTP 400, even though credentials, the selected Gemini model, and a fresh
tool cycle are healthy.

## Decision

On startup of a named `deep` session, inspect the persisted state. If its final
message is a tool result, clear that named thread before accepting new input and
show a concise terminal warning. Do not apply this recovery to complete
sessions, unnamed sessions, or orchestrated sessions.

## Alternatives considered

- Treat the failure as a credentials or model-permission error. Rejected because
  a fresh `gemini-3.5-flash` tool cycle completed successfully.
- Change the Vertex tool-response adapter. Rejected because its direct
  tool-cycle diagnostic completed successfully and did not reproduce the issue.
- Append a new human message to the interrupted checkpoint. Rejected because it
  preserves an invalid `human -> ai -> tool -> human` sequence.

## Validation

The controlled diagnostic completed a simple model response, tool request, and
tool response with `gemini-3.5-flash`. A fresh Deep agent also completed a
read-only `list_files` call and final response. Unit tests cover the checkpoint
shape that triggers recovery; full TypeScript and Jest validation is required
before merge.

## Consequences

Only an interrupted named session loses its persisted conversation history.
Operators receive an explicit warning and can continue immediately with a
valid empty session. A future implementation may add a safe checkpoint rollback
when LangGraph exposes that operation.
