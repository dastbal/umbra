# ADR-007: Self-heal named sessions after rejected tool cycles

## Status

Accepted — 2026-08-24

## Context

If Vertex AI rejects the request immediately after an interactive tool finishes,
LangGraph can persist the tool result without the final assistant response. The
next input to that named session then contains an invalid conversation sequence.
Users previously recovered by deleting the whole `.agent` directory, which also
discarded unrelated sessions, indexes, and configuration.

## Decision

The interactive CLI detects a Vertex HTTP 400 only when it follows tool activity
in a named session. It clears that session's checkpoint, recreates its agent,
and informs the user that the next instruction starts from a clean session.

The failed instruction is never replayed automatically. A tool may have already
performed a write or an external action, so replaying would risk duplication.

## Consequences

Users do not need to delete `.agent` to recover from this failure. Only the
affected named conversation loses history; RAG indexes, configuration, and other
sessions remain intact. Unnamed ephemeral sessions and unrelated provider errors
continue to surface normally.

---

## Amendment — 2026-09-21: the self-heal healed half the thread

The reset this record relies on is `DeepAgentFactory#clearCorruptedCheckpoint`,
and until now it deleted from two tables that have never existed in the saver's
schema. Only `checkpoints` was real; `writes` — the table holding the pending
writes of the interrupted tool call — was never touched, because the delete
naming it was spelled `checkpoint_writes` and threw into an empty `catch`.

So a session that reset itself kept the half of its state most likely to make the
provider reject the next turn. The full mechanism and the fix are in the
2026-09-21 amendment to
`ADR-005-incomplete-tool-checkpoint-recovery.md`; the behaviour this record
decided is unchanged, and now happens.

Nothing here reopens the decision that a rejected tool cycle is never *replayed*
automatically. The thread is cleared, not re-executed.
