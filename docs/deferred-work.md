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

> **Amendment — 2026-08-28.** The shared base changed, and **this entry still
> applies in full**. [ADR-020](./adr/ADR-020-a-message-that-asks-for-nothing-costs-nothing.md)
> reordered `buildSystemPrompt` so the identity and a conversation gate come
> before the evidence protocol, removed the skill-discovery fallback that ordered
> `list_files("skills/")` on every unmatched message, and rewrote two blocks that
> declared themselves mandatory on every turn.
>
> All three edits landed in the **shared base**, which is exactly the problem
> this entry describes: they reached `orchestrator` and `analysis` too, and
> neither was reasoned about. The conversation gate is harmless in both. The
> removed directory listing is a straightforward gain in both. But the fact that
> a change aimed at `simple` silently rewrote the other two prompts is the defect
> recorded here, arriving again.
>
> `evidence-protocol.ts` was deliberately left alone for the same reason, and
> that is the shape of the fix: the file is shared with
> `researcher.subagent.ts`, where an unconditional investigation protocol is
> correct. Step 1 — split the base so each mode appends only what it can act on —
> is unchanged and is what would have made the ADR-020 edits attributable.

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
`.umbra/`, and let a delegate start with what the last run established instead of
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
catalog into `.umbra/` with a `status` field and a refresh path, and both are
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

---

## A preflight that offers to fix each missing prerequisite

> Recorded 2026-08-28, branch `2.0.1`. David's own request, raised while the
> Project Id failure was still unexplained: *"si le doy deep y ve que no tiene
> permiso, lo primero que debería pedir es conectarse — que él mismo me ayude y
> corra lo de auth"*.

### The idea

`umbra deep` should establish its prerequisites **before** touching the network,
and when one is missing, offer to fix it in place rather than failing with the
underlying library's error.

### Why it was not built with ADR-017

The specific prerequisite that prompted the request turned out to be already
satisfied: the login *had* run, and the project it stored was simply never read.
[ADR-017](./adr/ADR-017-prerequisites-resolved-not-guessed.md) reads it, so
`umbra deep` now works without asking anything. Offering to re-run a login that
had already succeeded would have papered over the real defect.

**The general shape still applies, and is worth more than the one case.** What
shipped fixes one prerequisite. Nothing stops the next one — a missing Ollama
daemon, an unreadable `.env`, a revoked credential — from surfacing as a raw
library error again.

### The mechanism to reuse — do not invent one

`umbra doctor` already enumerates prerequisites and reports pass/fail per check
(`src/bin/cli.ts`, the `doctor` command). It is the check registry this needs.
What it lacks is a remedy attached to each check, and a caller that runs it
before the session starts.

The prompt surface also already exists: `confirm` in
`src/presentation/cli/prompts.ts`, which `umbra auth login` uses for its own
"opens your browser, continue?" gate ([ADR-012](./adr/ADR-012-arrow-key-selection-prompts.md)).

### Plan

1. Give each `doctor` check an optional remedy: a label and an action.
2. Run the checks at the start of `deep` and `orchestrate`. Only report anything
   when a check fails — a passing preflight must stay silent, or it becomes
   noise on every start.
3. For a failing check with a remedy, ask once, then re-run that check.
4. `--no-preflight` for CI and embedded use. A prompt that cannot be answered is
   worse than the original error.
5. Note the ordering hazard: today RAG indexing runs before the first message,
   so the preflight has to come before indexing, not before inference.

### Cost

Free when everything passes — the checks are local. The risk is startup latency
if a remedy is attempted automatically; step 3 exists to keep it operator-driven.

---

## Indexing should be transactional, and reindex only what is missing

> Recorded 2026-08-28, branch `2.0.1`. Produced by the ideation ritual's
> "borrow from another discipline" lens (a database), while diagnosing the run
> that reported `✅ Indexing Complete.` after fourteen failed batches.

### The idea

A database does not commit a partial transaction and call it a success. Indexing
should either report exactly what is missing, or be resumable so the gap closes
on the next run without redoing the work that succeeded.

### What is fixed already, and what is not

[ADR-017](./adr/ADR-017-prerequisites-resolved-not-guessed.md) stopped the lie:
a run with failed batches now reports `⚠️ Indexing finished with gaps` instead of
a green line. **It does not close the gap.** The chunks whose batches failed are
absent from the vector store, and the file registry has already marked their
files as processed — so the next run reports `✨ Project is up to date.` over an
index that is not.

That second half is the more interesting defect and it is untouched.

### The mechanism to reuse

`src/core/rag/indexer.ts` — `embedAndSaveBatches` now returns
`{ embeddedBatches, failedBatches }`, which is the hook. The registry that
decides what needs reprocessing is in the same module (`isFileChanged`).

### Plan

1. Establish what the registry records and when. The bug is that a file is
   marked processed before its vectors are known to be stored.
2. Record failed chunks, not just a count — enough to retry precisely.
3. Make `isFileChanged` (or a sibling) treat a file with missing vectors as
   needing work, so a later run heals the index with no operator action.
4. Decide whether automatic retry belongs here at all. In the observed run every
   failure had the same cause, so retrying would have multiplied a certain
   failure fourteen times — the value is in *resuming later*, not retrying now.
5. Validate by failing embeddings deliberately, fixing the cause, and confirming
   the second run indexes exactly the missing chunks.

---

## Umbra should not require Google to run at all

> Recorded 2026-08-28, branch `2.0.1`. The heretical candidate from the ideation
> ritual. **Contradicts an accepted decision and is recorded as a proposal, not
> a plan.**

### The heresy

The rule is written in `src/core/llm/provider.ts`: *"Embeddings are **always**
Vertex AI, regardless of which chat model is active."*
[ADR-010](./adr/ADR-010-umbra-public-package-and-cli.md) reinforces the shape by
shipping ADC auth commands as part of the package.

The consequence nobody chose: a **100% Ollama** user — the configuration the
README advertises as *"free, offline, and no API key needed"* — still cannot
index a project without Google credentials and a Google Cloud project. The
fourteen `Unable to detect a Project Id` errors that produced ADR-017 hit a
Gemini user, but the identical crash reaches the user who picked Ollama
specifically to avoid the cloud.

The proposal: embeddings follow the chat provider. Local chat, local embeddings.
Google becomes an option rather than a floor.

### What would make it worthless

The recorded rationale still stands and has to be faced, not dismissed: Ollama
embedding models are materially worse, and switching embedding models invalidates
the whole index — every switch means a full reindex. A per-provider index, or a
recorded embedding-model identity that forces a reindex on change, is the real
cost of this idea and the reason it is a proposal.

### Where it would touch

`src/core/llm/provider.ts` (`getEmbeddingsModel`), `src/core/rag/` (index
identity and invalidation). If it is ever accepted, it supersedes the module
rule above and amends ADR-010's packaging claim.

---

## A turn budget counted in bytes of context, not in tool calls

> Recorded 2026-08-28, branch `2.0.1`. Produced by the ideation ritual's
> "context as the product" lens while diagnosing the turn that spent 108 seconds
> on the word `hey`. David chose the multi-dimension governor
> ([ADR-019](./adr/ADR-019-turn-cost-is-the-bound-not-tool-calls.md)) and this
> stayed behind.

### The idea

The governor now bounds tool calls, tokens, wall clock and cost. None of those
is the unit the model actually spends when it reads a file. A **byte budget**
would be: once a turn has pulled roughly 150 KB of file content into context,
`safe_read_file` stops returning bodies and answers *"you have read 200 KB this
turn — use `ask_codebase`"*.

### What is actually broken today

In the 11-tool-call turn recorded as audit `84ad7c97`, the agent read **202,815
bytes** — including `deep-agent-factory.ts` (50 KB), `chat-session.ts` (48 KB)
and `cli.ts` (32 KB) — to answer a greeting.

`ask_codebase` was called **zero times** in those 11 calls. It is declared in
`DeepAgentFactory.create` and it is the tool
[ADR-003](./adr/ADR-003-on-demand-readme-index.md) and
[ADR-004](./adr/ADR-004-on-demand-adr-index.md) exist to provide. The agent has
semantic search over the project and reads whole files by hand instead.

The token ceiling added in ADR-019 bounds the *total*, which stops a runaway. It
does nothing to steer the model toward the cheaper tool while there is still
budget left.

### The mechanism to reuse — do not invent one

`src/core/agent/turn-governor.ts` already owns per-turn spend and already has a
dimension type. A `bytesRead` field and a `recordBytes` call from
`safe_read_file` is the whole accounting. `TurnSpend` is reset by `beforeAgent`,
so turn boundaries are solved.

### The plan

1. Add `bytesRead` to `TurnSpend` and a soft threshold distinct from the hard
   ceilings — this one redirects rather than stops.
2. Have `wrapToolCall` return a redirect `ToolMessage` for `safe_read_file` past
   the threshold, naming `ask_codebase` explicitly.
3. Measure first: count `ask_codebase` calls per turn across
   `interactive-turns.jsonl`. If the answer is near zero, the tool is being
   ignored for a reason worth finding before adding pressure.

### What would make it worthless

Truncating a read in the middle of real code work is worse than the tokens it
saves. This must redirect, never silently shorten a file, and the threshold has
to sit above what an honest multi-file task needs.

---

## The agent reading its own telemetry

> Recorded 2026-08-28, branch `2.0.1`. Produced by the ideation ritual's "the
> agent that observes itself" lens. Not chosen, and the reason it might be a bad
> idea is unusually clear.

### The idea

`.umbra/telemetry/interactive-turns.jsonl` records what every previous turn
cost. The agent never sees it. The proposal: inject a one-line summary of the
previous turn into the next turn's context — *"your last turn spent 11 tool
calls and 108 seconds on a greeting"* — so the cost becomes visible to the model
rather than only to the operator.

### Why it is interesting

Every bound built in ADR-019 is external: the middleware stops the model. This
would be the first mechanism that lets the model bound *itself*, and the data
already exists, is privacy-safe by construction, and is written on every turn by
`TurnAudit#record`.

### What would make it worthless, and it is a real risk

It spends tokens on every turn in order to save tokens. The summary is paid
forever; the savings are hypothetical. Before building it, the number to
establish is what fraction of expensive turns follow another expensive turn — if
runaways are independent events, telling the model about the last one teaches it
nothing.

### The mechanism to reuse

`src/presentation/cli/turn-audit.ts` writes the records. Reading the last line
back is trivial; `ChatSession#sendMessage` composes the input and is where a
prefix would go.

---

## Tool arguments reach the tools double-encoded

> Recorded 2026-08-28, branch `2.0.1`. Observed in the transcripts that produced
> [ADR-019](./adr/ADR-019-turn-cost-is-the-bound-not-tool-calls.md) and
> [ADR-020](./adr/ADR-020-a-message-that-asks-for-nothing-costs-nothing.md), and
> deliberately not chased there: it changes nothing about cost, and mixing it
> into that work would have made a failed run impossible to attribute.

### What is observed

`list_files` receives its arguments plainly:

```
{"dirPath":"skills"}
```

`safe_read_file` receives a JSON **string** wrapped in an `input` key:

```
{"input":"{\"file_path\":\"skills/mentor-mode.md\"}"}
```

Both calls succeed, so nothing is broken today. But two tools declared in the
same list are being invoked through two different argument shapes, which means
something between the model and the tool is disagreeing about the schema.

### Why it is worth a look before it bites

This is the same family as the entry above on harness tool exclusions: the set
of tools a model can call, and the shape it calls them with, is assembled in
more than one place and verified in one. A tool whose arguments arrive
double-encoded works right up until a value contains a quote.

### Where to start

Compare the zod schemas of `listFilesTool` and `safeReadFileTool` in
`src/core/tools/file-tools.ts`. The likely difference is a single-argument
schema being collapsed by deepagents into an `input` envelope, in which case the
fix is the schema shape, not the tool.
