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

---

## Amendment — 2026-09-21: the reset left behind exactly the rows it existed to remove

This record decided that a named session interrupted after a tool result is
recovered rather than left in an unusable checkpoint, and noted that a safe
partial rollback would be reconsidered when LangGraph exposed the operation. Two
things are now true that were not.

**The operation exists.** `SqliteSaver#deleteThread` ships in the installed
`@langchain/langgraph-checkpoint-sqlite` and removes a thread from both tables in
one transaction. The comment in `DeepAgentFactory#clearCorruptedCheckpoint`
saying the saver exposed no delete API was false against the installed version.

**The reset never worked.** That method opened its own `better-sqlite3` handle
and deleted from `checkpoint_writes`, `checkpoints` and `checkpoint_blobs`. The
saver's schema is exactly two tables — `checkpoints` and `writes`. Two of the
three statements therefore threw into an empty `catch`, and the `writes` rows
survived every reset. Those rows are the pending writes of an interrupted tool
call: the precise state this record exists to clear. It also opened a second
handle on a WAL file the live saver holds, and leaked it on any throw before
`db.close()`.

`clearCorruptedCheckpoint` is now `async` and delegates to `deleteThread`, after
a `getTuple` probe that does two jobs: `deleteThread` is the one method on this
saver that does not call `setup()` first, and the tuple supplies the *cleared*
boolean that `changes > 0` used to produce. The handle closes in a `finally`.
Three call sites in `src/bin/cli.ts` — two of them synchronous — now await it.

Still open, and recorded rather than fixed: the `'simple' | 'orchestrator'`
parameter cannot reach the `analysis` database that
`DeepAgentFactory#buildCheckpointer` also creates.

### Verification evidence

`npx jest --runInBand src/core/agent/checkpoint-clear.spec.ts` — 4 passed. The
first seeds a real checkpoint *and* a real pending write, then asserts both
tables reach zero; it fails against the previous implementation, which left the
`writes` row in place.
