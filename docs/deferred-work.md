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

> **Amendment — 2026-08-26.** The prompt half of this is now closed, and the
> shape turned out to be wider than one tool. Recorded rather than rewritten,
> because the analysis above is still the plan for building `ask_human`.
>
> - The **6** mentions (the table says 5; the sixth is the class TSDoc) were
>   rewritten so no prompt instructs the model to call `ask_human`. The
>   instructions that named it — "never delete without approval", the HITL gate
>   list — now describe what actually happens: `AgentSecurityPolicy` stops those
>   actions and raises the operator prompt itself, with no tool call involved.
>   **The tool is still unbuilt and this entry still applies**; only the false
>   advertising is gone.
> - `task` was the same defect in every mode, and it was worse: it was
>   *excluded* from the provider's declarations while three prompts ordered the
>   model to delegate through it. Fixed and recorded in
>   [ADR-013](./adr/ADR-013-subagent-tool-exclusion-and-provider-diagnostics.md).
> - `src/core/agent/prompt-tool-contract.spec.ts` now guards the `simple`
>   prompt: every tool name it uses must be a tool that mode declares. Adding
>   `ask_human` back to that prompt before the tool exists will fail the suite.

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

## Harness tool exclusions never reach the subagents

> Recorded 2026-08-26, branch `2.0.0`. Found by the first `umbra orchestrate` run
> that got past the delegation guard (see the amendment to
> [ADR-013](./adr/ADR-013-subagent-tool-exclusion-and-provider-diagnostics.md)).

### What is broken today

With delegation working, the orchestrator handed off to the researcher, then to
the coder, which wrote the file and verified it. The run then died on:

```
Error invoking tool 'read_file' with kwargs {"path":"src/app.ts"}:
Received tool input did not match expected schema
```

`read_file` is one of the six names in `detectGeminiIncompatibleTools`' baseline
exclusion list — excluded from the main agent precisely because deepagents'
version breaks here. No subagent declares it either: `createCoderSubAgent` lists
`safe_write_file`, `safe_read_file`, `list_files`, `run_tests`,
`run_integrity_check`, and the researcher lists `ask_codebase`, `safe_read_file`,
`list_files`, `list_adrs`.

It reaches the subagent from deepagents' own filesystem middleware, and the
exclusion does not follow: `_ToolExclusionMiddleware` wraps the **main** agent's
model call, while every subagent is a separate graph with its own middleware
stack and its own harness resolution.

### Why this keeps happening

It is the mirror of the `task` defect. There, a tool the prompt demanded was
withheld from the model. Here, a tool withheld *for being broken* is handed to
the subagents. Same blind spot in both: **the set of tools a model can call is
assembled in more than one place, and only one of those places is verified.**
`prompt-tool-contract.spec.ts` checks the main `simple` agent. Nothing checks
what a subagent ends up holding.

### Plan

1. Establish what each subagent actually receives at runtime — declared tools
   plus whatever its middleware contributes. Reading the specs is not enough;
   that is what made this invisible.
2. Apply the same exclusions there. Whether that is a harness profile per
   subagent, an explicit exclusion middleware in each spec, or suppressing the
   filesystem middleware for subagents that bring their own safe tools is the
   decision to make — deepagents' `SubAgent` type accepts `middleware`, which is
   the likely lever.
3. Extend the contract test to the subagents, so a tool nobody declared cannot
   appear in one again.
4. Validate with a real `umbra orchestrate` run that reaches the coder, which is
   the only way this surfaced.

### Note

Until it is fixed, `umbra orchestrate` can delegate and the coder can write, but
a subagent that reaches for `read_file` instead of `safe_read_file` ends the run.
`umbra deep` is unaffected: it has no subagents.

> **Amendment — 2026-08-27.** Step 3 of the plan is done and the entry still
> applies. `prompt-tool-contract.spec.ts` now covers all three subagents, so a
> subagent prompt naming a tool that subagent does not declare fails the suite —
> it immediately caught the Coder naming `write_file`, a mention that exists to
> forbid it, and the check now verifies the prohibiting form rather than excusing
> the name.
>
> **That closes one direction only.** A textual check reads what the prompt
> promises; it cannot see what deepagents' filesystem middleware hands the
> subagent at runtime, which is this defect. Steps 1, 2 and 4 stand unchanged,
> and step 1 remains the one that matters: *reading the specs is not enough*.
>
> One fact was established while wiring [ADR-014](./adr/ADR-014-delegation-mandate-shared-budget-and-question-channel.md)
> and is worth recording here, because it is the lever step 2 anticipated:
> `SubAgent.middleware` works, is now in production on all three subagents, and
> each subagent does receive the parent's `thread_id` — `createTaskTool` spreads
> the parent config into `subagent.invoke`. A per-subagent exclusion middleware
> is therefore reachable by exactly the same route the budget middleware took.

---

## One base prompt for three modes that declare different tools

> Recorded 2026-08-26, branch `2.0.0`. Found by the contract test added in
> [ADR-013](./adr/ADR-013-subagent-tool-exclusion-and-provider-diagnostics.md),
> and deliberately not fixed there: scoping a prompt changes what the model
> reads, which is a behaviour change that has to be validated by running the
> modes, not by a unit test.

### What is broken today

`buildSystemPrompt` composes one shared base — skill discovery, the ADR
protocol, the evidence protocol, the safety rules — and all three modes receive
it. But the three modes declare very different tools:

| Mode | Declares | Prompt names, but cannot call |
|---|---|---|
| `simple` | 9 tools + `write_todos` | nothing (guarded by the contract test) |
| `orchestrator` | `ask_codebase`, `refresh_project_index`, `run_integrity_check`, `write_todos`, `task` | `safe_write_file`, `safe_read_file`, `list_files`, `list_adrs` |
| `analysis` | **nothing** — `tools: []`, manifest-only by design | `safe_write_file` |

The orchestrator's base tells it to *"Call list_files for the relevant directory"*
and to *"Use safe_read_file on the most relevant files"*. It has neither. Its job
is to delegate, so the instructions belong to the subagents that do the reading —
but the model is the one being told.

`analysis` is subtler and only partly a defect: it names tools **to forbid
them** (*"Do not call list_files"*), which is correct for a manifest-only mode.
What is wrong there is inherited write guidance — *"A file only exists on disk
after `safe_write_file` is called"* — in a mode that cannot write at all.

### Why a textual check cannot close it

A prohibition and an instruction look the same to a regex. That is why the
contract test is scoped to `simple`: extending it to the other two would need
either a per-mode exception list — five entries, which is how a guard turns into
decoration — or an understanding of intent the test cannot have.

### Plan

1. Split the base: the shared part keeps only what every mode can act on
   (output format, safety posture, evidence discipline).
2. Each mode appends the instructions for the tools **it** declares, taken from
   the same list the factory passes to `createDeepAgent`, so the two cannot drift.
3. For `analysis`, keep the prohibitions — they are load-bearing — and drop the
   write-verification guidance that has no tool behind it.
4. Extend `prompt-tool-contract.spec.ts` to the other two modes once each
   prompt's vocabulary matches its declarations, and delete the scoping note in
   that file's TSDoc.
5. Validate by running `umbra orchestrate` and `umbra analyze` and reading the
   traces — a prompt change is only verified by what the model then does.

---

## The `/` command palette — **built 2026-08-26**

Implemented after all. Kept here rather than deleted, because the reasoning
about *why it was expensive* is what a future reader needs when deciding whether
to extend the line editor further.

`src/presentation/cli/line-editor.ts` — `editLine` — replaces `readline` at the
chat prompt on a TTY. Typing `/` opens a dimmed list below the prompt that
filters as more is typed, `↑↓` move the `❯` pointer, Enter or Tab take the
highlighted row, Escape or Ctrl+G dismiss it. The palette reads the same command
registry as the dispatcher, the picker, the help text and Tab completion, so it
is its fifth consumer and needed no list of its own.

**What it cost, as predicted:** everything `readline` gave for free had to be
reimplemented — backspace, delete, cursor movement, Home/End, `Ctrl+A/E/U/K/W`,
`↑↓` history, and code-point-correct editing so `á` and `ñ` survive.

**The escape hatch is the mitigation that made it acceptable.**
`UMBRA_SIMPLE_PROMPT=1` forces the old `readline` prompt on a real terminal, so
an operator who hits a defect here keeps working. Without a TTY the editor is
never used at all.

### Still open, and worth knowing before extending this

- **A lone ESC byte is ambiguous to the keypress decoder.** With no
  `readline.Interface` supplying an escape timeout, `emitKeypressEvents` emits
  nothing for a solitary ESC until another byte arrives — verified directly:
  `ESC ESC` produced no event, `ESC ESC ESC` produced one, and `ESC` followed by
  Enter arrived as `meta+return`. Escape is still handled, but Ctrl+G is offered
  as the key that always lands, and the menu hint now reads `esc/q cancel`
  rather than promising Escape alone. Fixing this properly means supplying an
  escape timeout, which means an owning `Interface` — a change to how the
  editor reads input, not a tweak.
- **Long lines are not wrapped.** The repaint assumes the prompt plus the text
  fits on one row. A line longer than the terminal will confuse the cursor
  arithmetic. Not hit in normal use; a real limit all the same.
- **Paste arrives one character at a time.** The decoder feeds a pasted chunk
  through as individual keypresses, so each triggers a repaint. Correct, but a
  very large paste will be slow.


---

## An index of what the Researcher already asked

> Recorded 2026-08-27, branch `2.0.0`. Generated during the divergence phase that
> preceded [ADR-014](./adr/ADR-014-delegation-mandate-shared-budget-and-question-channel.md)
> and deliberately not built: the mandate had to exist first, because it is where
> such an index would be injected.

### The idea

Every Researcher run re-derives, from nothing, *what to ask the codebase*. The
questions themselves are the expensive part — six semantic searches on
2026-08-27 — and they are thrown away when the delegation ends.

This is the shape that produced three of this project's load-bearing ideas:
`askrag`, `list_readmes` ([ADR-003](./adr/ADR-003-on-demand-readme-index.md)) and
`list_adrs` ([ADR-004](./adr/ADR-004-on-demand-adr-index.md)). In each, the
valuable artifact was not the answer but **the cheap index that made the answer
findable**. Applied here: cache question → finding pairs per module under
`.agent/`, and let a delegate start with what the last run established instead of
re-asking.

### What is broken today

Nothing is broken. This is the one entry here that records an opportunity rather
than a defect, which is why it is worth stating plainly: an index that is not
needed is a stale index waiting to mislead.

Partial mitigation already shipped: findings from one delegation are carried into
the order of the next, within a single turn (`recordFinding`, and the
*"Already established this turn"* section of a rendered mandate). What is missing
is persistence **across** turns and sessions.

### The mechanism to reuse — do not invent one

`src/core/rag/` and the two existing on-demand indexes. Both write a cached
catalog into `.agent/` with a `status` field and a refresh path, and both are
already exercised by their own specs. The injection point is
`Mandate.knownContext`, which the guard already renders into the delegate's only
message.

### The hazard that decides whether this ships

A stale index lies with confidence, and a delegate cannot tell an inherited
finding from one it verified. Any implementation must carry provenance and an
age, and the mandate must present inherited findings as *"established on
&lt;date&gt;, re-verify if load-bearing"*, never as fact. Without that, this makes
the agent faster and wronger.

### Plan

1. Decide the cache key. Per module path is the obvious unit; per question is too
   sparse to ever hit.
2. Persist question → finding with provenance: which delegation, which turn,
   which commit.
3. Inject into `knownContext` at mandate build time, capped, marked with age.
4. Invalidate on `refresh_project_index`, which already exists.
5. Validate by running the same request twice and comparing the tool-call count
   of the second run against the first.

---

## The orchestrator holds a research tool its prompt forbids it to use

> Recorded 2026-08-27, branch `2.0.0`. Surfaced by the heretical idea in the
> divergence phase before ADR-014 — the proposal to merge the Researcher into the
> orchestrator, which was rejected. The inconsistency it exposed is real and
> outlived the proposal.

### What is broken today

`createOrchestrator` declares `ask_codebase`, `refresh_project_index` and
`run_integrity_check`. Its prompt tells it to delegate all analysis, and lists
`ask_codebase` under *"For quick questions you can answer yourself without
delegating"* — so the two are not in flat contradiction, but the boundary is
stated nowhere and is left to the model.

This is the same family as the entry below on one base prompt serving three
modes: the orchestrator's inherited base still instructs it to call `list_files`
and `safe_read_file`, which it does not declare.

### Why it was not fixed in ADR-014

ADR-014 changed what the orchestrator is told about delegation. Changing what it
is told about its *own* tools at the same time would have made a failed run
impossible to attribute. Prompt changes are verified by what the model then does,
and two at once cannot be told apart.

### Plan

Fold into the existing entry *"One base prompt for three modes that declare
different tools"*, below — the fix is the same fix, and splitting it would create
two half-solutions to one problem.

---

## A reasoning intermediary between orchestrator and delegate

> Recorded 2026-08-27, branch `2.0.0`. David's idea, in its original shape.
> ADR-014 shipped the deterministic half; this records what was set aside and the
> condition under which it should come back.

### The idea

An agent that sits between the orchestrator and its delegates: it holds what the
orchestrator asked for and what the delegate has found, answers the delegate's
questions itself, and lets the work continue without the orchestrator spending a
turn.

### What shipped instead, and why

The `DelegationBroker` does the same job without a model: it answers from the
mandate by quoting it, escalates to the operator when the mandate does not cover
the question, and never synthesizes. The reasoning was that the valuable part of
an intermediary is *memory and a budget*, not intelligence — and that a third
model costs tokens and latency, can hallucinate, and becomes a fourth agent to
bound, which is the problem being solved.

### The condition for revisiting

One measurement decides it: **how often the broker fails to answer a question the
mandate does in fact cover.** Word overlap is a crude matcher. If traces show
delegates escalating questions whose answers were sitting in `knownContext`, the
matcher is the bottleneck and a small model reading the mandate would beat it.

Until that number exists, this stays unbuilt. `answerDelegateQuestion` already
labels every reply with its `source`, so the measurement costs nothing but a
trace to read.

### Plan

1. Read three real `umbra orchestrate` traces and count `source: 'human'` replies
   whose answer was present in the mandate.
2. If that count is low, the broker is sufficient — close this entry.
3. If it is high, replace only the matcher: a cheap model given the mandate and
   the question, returning the relevant sections. Keep the quotation rule; the
   model selects, it does not answer.
