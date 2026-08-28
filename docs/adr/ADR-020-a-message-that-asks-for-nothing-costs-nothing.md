# ADR-020: A message that asks for nothing costs nothing

Category: Runtime behavior and prompt economy

Author: Claude

Date: 2026-08-28

## Status

Accepted

## Deciders

David Balladares, with Claude

## Context

`hey` cost 11 tool calls and 108 seconds (audit `84ad7c97` in
`.umbra/telemetry/interactive-turns.jsonl`). `hola maestro`, in the session
before it, cost 6 tool calls and 20.3 seconds.

ADR-019 bounds what a turn may spend. This record is about the turns that should
never have started.

The agent was not misbehaving. It was obeying three instructions, none of which
had an exception for a message that asks for nothing:

| Instruction | Where |
| --- | --- |
| *"Do not answer before investigating the current workspace."* | `evidence-protocol.ts#buildEvidenceProtocolPrompt`, composed **first** in the prompt |
| *"SKILL DISCOVERY — mandatory before every task"*, whose no-match fallback was *"call `list_files(\"skills/\")`"* | `deep-agent-factory.ts#buildSystemPrompt` |
| *"SESSION STATE VERIFICATION (mandatory on every turn)"* | `deep-agent-factory.ts#buildSystemPrompt` |

`hey` matches no skill keyword, so the fallback ordered a directory listing —
which is exactly the first tool call in both recorded transcripts. The prompt
contained neither the word `greeting` nor `trivial`.

A guard already existed and was wired to the wrong mode. `GREETING_PATTERN` in
`task-classifier.ts` matches `hey` and `hola`, but
`ChatSession#sendMessage` consulted the classifier only when
`mode === 'orchestrate'`. Under `umbra deep` it was dead code. Even when it did
run, a greeting routed to `subagents: []`, rendered as *"answer with read-only
tools only"* — which **authorises** tools rather than forbidding them.

## Decision

Two changes: one that stops the turn before it starts, and one that removes the
instructions which made it expensive.

### The gate, in one place, before the graph

`classifySmallTalk` in `src/core/agent/task-classifier.ts` returns
`'greeting' | 'thanks' | 'farewell' | null`. `ChatSession#handledAsSmallTalk`
consults it and answers via `ChatSession#replyToSmallTalk` with no model call
and no tool call.

Both entry points route through that one method. `ChatSession#promptLoop` is the
interactive path; `ChatSession#start` is the CLI-argument path, and it calls
`sendMessage` directly — a gate placed only in the loop would have left
`umbra deep "hey"` paying the full cost. This mirrors the `looksLikeSlashCommand`
branch already in `promptLoop`: recognised locally, answered without spending a
turn.

**Affirmations are deliberately excluded.** `ok`, `dale`, `listo`, `yes`, `sí`,
`seguí` and `continuá` do **not** match. They routinely mean *proceed with what
you proposed*, and answering one with a canned line would refuse work the
operator had just approved. A false negative here costs tokens; a false positive
costs the user's actual request. Every pattern is anchored to the whole message,
so `hola, agregá un endpoint` remains a task.

### The prompt: one addition and one subtraction

In `DeepAgentFactory#buildSystemPrompt`:

- The identity now comes first, then a **`CONVERSATION GATE`** block declaring
  that it takes precedence over every protocol below, then the evidence
  protocol. Previously the evidence protocol was composed first, in the position
  of highest authority.
- The skill-discovery no-match fallback no longer orders a directory listing.
  The keyword map is the complete list of the eleven shipped skills, so listing
  `skills/` discovers nothing and costs a round trip.
- `mandatory before every task` and `(mandatory on every turn)` were rewritten as
  conditions. The rendered `simple` prompt now contains the word "mandatory"
  **zero** times, down from three.

`evidence-protocol.ts` is deliberately **not** modified. It is shared with the
Researcher subagent (`researcher.subagent.ts`), where an unconditional
investigation protocol is correct — a researcher always investigates. Softening
the shared file would have fixed `deep` by degrading the Researcher. The gate
declares its own precedence instead.

## Alternatives considered

| Solution | Pros | Cons | Decision |
| --- | --- | --- | --- |
| Add a triviality exception inside `buildEvidenceProtocolPrompt` | One edit, at the strongest instruction | That file is shared with the Researcher, where the protocol must stay unconditional | Rejected |
| Wire the existing classifier into `deep` and let the model answer the greeting | Reuses what exists; no canned text | The route says *"read-only tools only"*, which authorises tools; it still costs a full model call | Rejected |
| Prompt-only gate, no code path | No canned replies, model stays in control | Competes with three absolute instructions and still pays one model call for `hey` | Rejected |
| Local gate before the graph, plus removing the instructions that caused the cost | `hey` costs literally zero; the prompt stops ordering pointless work | A canned reply is the CLI speaking, not the agent; the pattern must be kept narrow | Accepted |

## Consequences

### Positive

- A greeting costs zero model calls and zero tool calls, and produces no audit
  record because the turn never starts.
- The prompt no longer instructs the model to list a directory it already has
  enumerated.
- `classifySmallTalk` also routes thanks and farewells off the delegation path in
  `orchestrate`, which `GREETING_PATTERN` alone did not.

### Neutral

- `GREETING_PATTERN` is kept and is now one of three patterns behind
  `classifySmallTalk`. `classifyOrchestrationTask` consults the classifier rather
  than the raw pattern, so the two cannot drift.
- The reply is deliberately terse and in English, matching the CLI's other
  first-person strings. It is the CLI acknowledging a greeting, not the agent
  reasoning about one.
- A farewell points at `/exit` rather than closing the session. Leaving is the
  operator's decision.

### Negative

- **The prompt change is verified structurally, not behaviourally.** The composed
  prompt was rendered and asserted; what the model does with it needs a live run.
  A prompt change is only ever verified by what the model then does, which is why
  it shipped separately from ADR-019's enforcement changes — two behaviour
  changes at once cannot be attributed. `deferred-work.md` records the same
  reasoning for not touching the orchestrator prompt inside ADR-014.
- The small-talk list is finite and monolingual-ish (English and Spanish). An
  unmatched greeting simply costs what it costs today; it does not break.
- Removing "mandatory" from two blocks is a real reduction in instruction
  strength. If the model becomes lax about session-state verification, that is
  the trade being made, and the block is still present.

## Verification Evidence

- `npm run type-check` — clean.
- `npx jest --runInBand` — **525 passed, 5 skipped**.
- `chat-session.spec.ts` asserts the point directly: for `hey`, `hola`,
  `gracias` and `chau`, `expect(agent.streamEvents).not.toHaveBeenCalled()`.
- The same spec asserts `explain the RAG module`, `hola, agrega un endpoint de
  usuarios`, `dale` and `segui` all pass **through** to the agent.
- `task-classifier.spec.ts` covers nine affirmations that must never match, and
  the tests found two real defects in the pattern while being written:
  `hello there` was uncovered because `( there)?` bound only to `hey`, and a
  leading `¿` broke the anchor, so `¿cómo estás?` reached the full graph. The
  patterns were fixed; the tests were not weakened.
- The composed prompt was rendered from the built `dist/` and asserted: identity
  first, `CONVERSATION GATE` before `EVIDENCE-GATED`, no `list_files("skills/")`,
  and zero occurrences of "mandatory".
- **Not yet verified live.** No `umbra deep` session has been run against a real
  provider since these changes.

## Related Files

- `src/core/agent/task-classifier.ts` — `classifySmallTalk`, `SmallTalkKind`,
  `GREETING_PATTERN`, `THANKS_PATTERN`, `FAREWELL_PATTERN`,
  `classifyOrchestrationTask`.
- `src/presentation/cli/chat-session.ts` — `ChatSession.handledAsSmallTalk`,
  `ChatSession.replyToSmallTalk`, `ChatSession.promptLoop`, `ChatSession.start`.
- `src/core/agent/deep-agent-factory.ts` — `DeepAgentFactory.buildSystemPrompt`.
- `src/core/agent/evidence-protocol.ts` — `buildEvidenceProtocolPrompt`
  (unchanged, and deliberately so).
- `src/core/subagents/researcher.subagent.ts` — `RESEARCHER_SYSTEM_PROMPT`, the
  other consumer that made the shared file off-limits.
- `src/core/agent/task-classifier.spec.ts` — small-talk and affirmation coverage.
- `src/presentation/cli/chat-session.spec.ts` — `ChatSession conversation gate`.
