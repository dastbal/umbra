# Deferred work

Work that was scoped, investigated, and deliberately **not** implemented, with
enough detail to be picked up without repeating the investigation.

This file is versioned on purpose. A finding that lives only in a machine-local
save state is a finding that disappears with the disk — and an open defect is
exactly the kind of state worth reading next session.

Each entry records what the idea is, what is actually broken today, the
mechanism to reuse, and the plan. When one is implemented, move it out and
record the decision as an ADR.

---

## `ask_human` with multiple choice

> Recorded 2026-08-26, branch `2.0.0`. Deferred by David in the session that
> found it: that session was scoped to hardening the prompt engine.

### The idea

The agent should be able to ask the operator a question with **selectable
options** and receive the answer back — not only free text.

The renderer already exists and is verified on a real terminal:
`select` and `multiSelect` in `src/presentation/cli/prompts.ts`, decided in
[ADR-012](./adr/ADR-012-arrow-key-selection-prompts.md). Nothing about the UI
needs to be built.

### The open defect this would close

`ask_human` is **advertised to the Deep Agent but registered in it nowhere**:

| Fact | Evidence |
|---|---|
| `askHumanTool` in `src/core/agent/deep-agent-factory.ts` | **0 occurrences** — not imported, not in the tool list |
| `ask_human` in the Deep Agent system prompt | **5 mentions instructing the model to use it** |

That prompt tells the model *"never delete files or directories without
`ask_human` approval"* and lists it under *"Standard orchestration tools"*. The
class TSDoc claims *"Includes: write_todos, ask_human, …"*. The model is
instructed to call a tool that mode does not have.

This is the same shape as the `deleteFileTool` defect
[ADR-011](./adr/ADR-011-path-containment-and-real-approval.md) recorded: a tool
advertised to the model and present in no tool list.

The tool that does exist — `askHumanTool` in
`src/core/tools/interaction-tools.ts` — returns the placeholder string
`WAITING FOR HUMAN: <question>`. The component that actually asks is
`src/bin/cli.ts`, in the `dangerous_actor` branch of the **legacy graph** path
that ADR-011 deprecated. Under `umbra deep` that code never runs.

### The mechanism to reuse — do not invent one

`src/core/tools/utils/approval.ts` — `requestApproval` raises a LangGraph
`interrupt()`; the run suspends, `ChatSession#handleHITL` renders the request,
and the graph resumes via `Command({ resume })`. It is in production for the
security gate.

This is the same pattern MCP calls *elicitation* and Claude Code exposes as
`AskUserQuestion`, and the principle is what makes it portable: **the tool
declares what it needs to know, the client decides how to ask it.**

Two hazards are already documented at that call site and apply unchanged:

- `interrupt()` **throws** to suspend, so on resume the tool body re-runs from
  the top. Return the answer *after* the interrupt, never before it.
- Any `try/catch` between the tool and the graph must call
  `rethrowIfSuspension` first. ADR-011 records a live failure where a generic
  `catch` swallowed the suspension: the graph never paused, the operator was
  never asked, and the tool reported an ordinary error.

### Plan

1. **Decide: one tool or two.** Recommendation is one, rewritten, so
   `coder.graph.ts` and the legacy `cli.ts` path keep working. Two tools that
   ask the same thing is how the four-copy slash command problem started (see
   ADR-012's first amendment).
2. **Schema:** `{ question: string, options?: string[], multiple?: boolean }`.
   `options` optional on purpose — absent means free text, which is today's
   behaviour; present means a menu.
3. **Discriminate the payload.** `ChatSession#handleHITL` currently assumes
   every interrupt is `actionRequests` + `reviewConfigs`. A question is not an
   approval. Without a type field, either the security gate breaks or a question
   renders as if it were a delete authorization — and confusing those two on
   screen is worse than not shipping the feature.
4. **Render** with `select` / `multiSelect`.
5. **Cancelling is not an answer.** Unlike the security gate, where Escape means
   reject, cancelling a question must return *"the user did not answer, use your
   judgement"*. Never fabricate a reply, and never let the absence of one look
   like a choice.
6. **No channel** (unit tests, embedded use): return an explicit "no human
   available" string. Same rule as step 5 — it must never read as an answer the
   operator gave.
7. **Fix the prompt** so its five mentions describe what the tool really does.
8. **Tests** (`src/core/tools/utils/approval.spec.ts` is the pattern) and an ADR.

### Cost

Unlike the `/` command palette — free, being local filtering — this one is not:
the question and the answer both enter the model's context, roughly 50-100
tokens plus an extra agent turn per question. Small per question.

The real risk is not price but a model that asks about everything, spending a
turn each time. That is controlled in the prompt, and the existing
`use ask_human ONLY for:` list is the right shape — but it has never been
exercised, because the tool was never callable. Treat that limit as unproven.

---

## The `/` command palette

> Recorded 2026-08-26. Deferred on cost/benefit, not on a defect.

Typing `/` would show the command list below the prompt, filtering as the
operator keeps typing, navigable with the arrow keys.

**The primitive it needs already exists**:
`completeSlashCommand` in `src/presentation/cli/slash-commands.ts` returns the
commands still reachable from a partial input, and a bare `/` returns all of
them. `ChatSession#completions` exposes it and is deliberately unused.

**What makes it expensive is not the palette.** Showing suggestions while the
operator types requires raw mode, and raw mode means `readline` cannot be the
reader — so its line editing has to be reimplemented: backspace and delete,
cursor movement, `Ctrl+A`/`E`/`U`/`W`, bracketed paste, multi-byte characters so
`á` and `ñ` survive, and `↑↓` history.

The risk is what separates this from ADR-012's menus: `readline` is the input
path for the **entire session**. A bug in a menu breaks a menu; a bug in the
line editor means the operator cannot type. This is also the point where Ink
starts to justify its cost, which would reopen a trade-off ADR-012 settled.

**Token cost: zero.** Filtering is a `startsWith` over an in-memory array with
no model call, and a repaint is roughly 300 bytes to stdout per keystroke.

**Recommendation:** revisit at roughly a dozen commands. With four, the
navigable `/help` already solves discovery.

**Update — 2026-08-26: the cheap half is done.** `readline` accepts a
`completer`, so Tab completion needed no raw mode and no change to the input
path. `buildSlashCompleter` in `src/presentation/cli/slash-commands.ts` reads
the same registry, and `ChatSession#readLine` passes it to `askText`. Tab
completes an unambiguous prefix, Tab twice lists the candidates, and ordinary
prose is left alone.

What remains deferred is only the **live** palette: the list appearing and
filtering as you type, without pressing anything. That is the part that needs
the line editor described above, and the risk assessment above stands unchanged.
