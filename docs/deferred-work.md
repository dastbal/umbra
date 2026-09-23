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

## Long-context Ollama embedding profiles

> Deferred 2026-09-03 after an oversized `nomic-embed-text` input exposed its
> 2K context limit. The safe chunk-fragment guard shipped first.

### The idea

Evaluate `qwen3-embedding:0.6b` as an explicit optional Ollama model for code
retrieval. Its published 32K context can reduce fragmentation without changing
the portable hybrid-retrieval policy.

### What is actually missing

Umbra accepts an Ollama model override but its adapter currently declares the
default model's dimensions. Changing the model name alone could stamp an
incorrect identity even though `chunk_vectors` correctly separates rows by
provider and model.

### The mechanism to reuse

`EmbeddingsIdentity`, `chunk_vectors.dimensions`, provider backfill and the
fixed-corpus audit already make a model experiment isolated and reversible.
`splitChunksForEmbedding` guarantees that a model change is not required merely
to avoid an oversized input.

### Plan

1. Pull the candidate only with operator approval and probe one local vector to
   record its actual dimensions and context behaviour.
2. Add a named model profile; never infer dimensions from a model string.
3. Build its rows beside `nomic-embed-text`, then benchmark against the fixed
   corpus. Do not promote it for context length, disk use or latency alone.
4. Keep the remaining ideation candidates — pressure-map telemetry, AST symbol
   cards, FTS-only fallback and a semantic-opt-in default — deferred until a
   measured retrieval problem justifies them.

> **Amendment — 2026-09-10.** Two of those four candidates now have their
> measurement, and it points the opposite way from what "FTS-only fallback"
> assumed. Scored on the calibration split at `e72d7a8`, removing the semantic
> branch costs **twenty points of Hit@4** — 0.867 to 0.667 — and eight of the
> nine positives it loses were *answered* rather than abstained: the lexical arm
> returned files, confidently, and they were wrong. A fallback that silently
> degrades to that is worse than an error.
>
> So FTS-only survives only as an **opt-in** for a consumer who wants an instant
> boot and has been told the price, never as a fallback the server chooses on its
> own. The full reasoning is in *Retrieval without vectors, and the number that
> closed it*, and `npm run bench:fts-only` is how the number is re-derived on any
> repository. Pressure-map telemetry and AST symbol cards are untouched and still
> waiting.

---

## Markdown documentation chunks for retrieval

> Deferred 2026-09-03 while implementing ADR-029. David chose TSDoc-only
> enrichment for the current retrieval iteration.

### The idea

Index curated project documentation (`README.md` and selected `docs/**/*.md`)
as document chunks with heading metadata, separate from code chunks. A returned
document would be labelled as documentation rather than presented as source
code.

### What is actually missing

`IndexerService#getAllFiles` currently indexes only non-test TypeScript under
`src/`. TSDoc now describes a class or method, but it cannot answer a project
workflow documented only in Markdown.

### The mechanism to reuse

`code_chunks`, FTS5 and `RetrieverService` already support typed chunks and
rank fusion. A document chunker would need its own path allowlist and heading
parser; it must not append every README body to every TypeScript chunk.

### Plan

Define the documentation allowlist and result labelling first. Then add a
separate document chunk type, test that generated notes and dependency READMEs
stay excluded, and benchmark it against source-only retrieval before changing
the default corpus.

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

> **Closed 2026-08-28** by
> [ADR-023](./adr/ADR-023-interlocking-triage-readback-and-balanced-books.md).
> Kept rather than deleted, because the reasoning below is what a future reader
> needs before handing subagent construction back to a library.
>
> The fix was not the one planned here. Step 2 expected a per-subagent exclusion
> middleware; what happened instead is that this project stopped letting
> `deepagents` build the graphs at all. `subagent-registry.ts` compiles the three
> delegates from the same specifications that already described them, so **a
> delegate holds exactly the tools its specification declares** and the list is
> no longer assembled in a second, unverified place.
>
> That was not done for this defect — it was forced by ADR-023, whose delegation
> tool carries the order in its schema and therefore has to own its dispatch.
> Closing this was the consequence, which is worth noting: the entry sat open for
> two days as a defect worth fixing, and was closed as a side effect of something
> else. Step 3 of the plan below shipped separately: the contract test now covers
> all three subagent prompts.

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

---

## Rendering the model's reasoning, when the operator asks for it

> Recorded 2026-08-28, branch `2.1.3`. Surfaced by the ADR-006 amendment that
> stopped the reasoning leaking into the answer. Deferred because it is a
> feature with a UI decision inside it, not the defect that was being fixed.

### The idea

`Show the model's reasoning` should actually show it — visually separated from
the answer, the way a thinking block reads in a chat client: dimmed, boxed, and
skippable.

### What is actually true today

No provider's reasoning reaches the screen, whatever the operator chooses:

| Model family | What Umbra sends | What the CLI does |
|---|---|---|
| Claude 5 (`controllable`) | `thinking: { type: 'adaptive', display: 'summarized' }` when the toggle is on | hides it — `readVisibleText` drops `thinking` blocks |
| Claude 4.5 (`forced-on`) | thinking budget, reasoning always returned | hides it |
| Gemini 2.5 (`forced-on`) | thinking budget, `includeThoughts` derived by the library | stripped in `VertexChatAdapter._generate` |
| Gemini 3.x (`unavailable`) | `thinkingLevel`, no thoughts returned | nothing to hide |

So the `controllable` toggle changes the request and nothing else. It is
**billed and discarded**. The menu now says exactly that rather than implying a
display — see `DISPLAY_HINTS` in `src/presentation/cli/model-menu.ts` — because
this repository's own rule, written in `reasoning-profile.ts`, is that a switch
which silently does nothing is worse than one that admits what it cannot do.

### The mechanism to reuse

Everything needed already exists and is verified:

- `readVisibleText` (`src/core/llm/visible-text.ts`) already **identifies**
  reasoning blocks across all three provider spellings. It discards them; the
  feature needs it to return them separately instead — a second return value,
  not a second classifier.
- `VertexChatAdapter._generate` already splits the two halves before the Vertex
  transport fuses them into one string. It emits the visible half; the reasoning
  half is right there beside it.
- `StreamRenderer` already owns transient, styled, non-answer output — the tool
  box and the wait indicator prove the pattern.

### The plan

1. `readVisibleText` returns `{ visible, reasoning }` rather than a string.
   Every current caller reads `.visible` and behaves exactly as it does now.
2. `StreamRenderer.streamReasoning(text)` renders the reasoning half dimmed and
   clearly outside the answer. This is the actual design decision, and it is why
   this is deferred: inline dim text, a collapsible box, and a `/thinking` pager
   are three different products.
3. The CLI passes the reasoning half only when
   `describeReasoning(model).display === 'controllable'` **and**
   `AGENT_REASONING_DISPLAY` is on. `forced-on` stays hidden: the operator did
   not ask, and Anthropic's unsummarized thinking is long.
4. `ReasoningDisplaySupport` then means what it says again, and ADR-016's
   `forced-on` row gets an amendment noting that the library limitation it
   describes is about the *request*, never about the display.

### Why it was not done now

The session was scoped to a rendering defect: the model's private deliberation
was reaching the operator as if it were the reply. Adding a deliberate way to
show that same text, in the same session, is how a fix turns into a feature
nobody reviewed.

---

## The middleware that threw `undefined`

> Recorded 2026-08-28, branch `2.1.3`. Open defect, **not** a design choice:
> deferred because it could not be reproduced, not because it was judged not
> worth fixing.

### What was seen

A `umbra deep` turn died immediately, before any output:

```
✗ Error
└─ Cannot read properties of undefined (reading 'message')
   at MiddlewareError.wrap (…/langchain/dist/agents/errors.cjs:69:10)
```

### What is known

`MiddlewareError` is LangChain's wrapper for anything a middleware throws. It
copies the wrapped error's message onto itself (`errors.cjs`:54) and keeps the
original in `cause` (`errors.cjs`:57). So:

- The message shown **is the original's**, repeated by the wrapper.
- The frame shown is **the wrapper's**, not the failure's.
- Something inside a middleware read `.message` on `undefined`.

The four hooks this repository owns are `wrapToolCall` in
`orchestration-guard.middleware.ts`, `iteration-budget.middleware.ts` and
`delegation/subagent-budget.middleware.ts`, plus `beforeAgent` in
`iteration-budget.middleware.ts`. None of them reads `.message` on a value that
can be undefined by inspection, so the read is either in a helper they call or
in a code path only a specific failure reaches.

### What already changed

Nothing that fixes it. `describeErrorOrigin`
(`src/presentation/cli/error-origin.ts`) now walks the `cause` chain and prints
the deepest frame, so **the next occurrence will name the file and line
itself**. That is the whole reason this can wait: the next report will be a
diagnosis rather than a mystery.

### The plan

1. Wait for a recurrence and read the frame the CLI now prints.
2. If it recurs without a usable frame, the fallback is to have the middleware
   boundary catch, log, and rethrow — but that is a scaffold to remove
   afterwards, not a fix, and it should not be built before step 1.

### What must not be done

Do not "fix" this by making the middleware boundary swallow a non-`Error`. It
would silence the crash and destroy the only evidence, and the constitution's
rule stands: a caught exception is handled or rethrown with context, never
dropped.

---

## The question log as the index

> Recorded 2026-09-02, branch `2.1.3`. Generated during the divergence phase
> that preceded [ADR-024](./adr/ADR-024-umbra-as-a-read-only-mcp-server.md)'s v1
> and deliberately not built: the server had to exist first, because it is the
> only place four agents converge.

### The idea

Umbra now answers four clients — Claude Code, Codex, Antigravity, Gemini CLI —
through `umbra mcp`. Record **what they ask**, not what they are told, and that
log is the first dataset this project has ever had about which parts of a
codebase are actually hard to understand.

This is the shape that produced three of this repository's load-bearing ideas:
`askrag`, `list_readmes` ([ADR-003](./adr/ADR-003-on-demand-readme-index.md)) and
`list_adrs` ([ADR-004](./adr/ADR-004-on-demand-adr-index.md)). In each, the
valuable artifact was not the answer but **the cheap index that made the answer
findable**. Applied here, the questions themselves are the artifact.

It is also the cheapest idea in this file: no model, no credentials, on the side
of ADR-024 that is already deterministic.

### What is broken today

Nothing. This is an opportunity, not a defect — and the entry *An index of what
the Researcher already asked* in this same file says why that matters: **an index
that is not needed is a stale index waiting to mislead.** Read that entry before
building this one; it is the same idea one layer out, and it carries the hazard
analysis.

### The mechanism to reuse — do not invent one

- `src/presentation/mcp/umbra-mcp-server.ts` — `callTool` is the single choke
  point every tool call passes through. One append there captures everything.
- `.umbra/telemetry/` already exists as the convention for local JSONL
  (`interactive-turns.jsonl`, ADR-008 / ADR-019).
- `src/core/rag/index-stamp.ts` — the provenance pattern to copy: an identity, a
  timestamp, and a status, written next to the thing it describes.

### The hazard that decides whether this ships

A log of questions is a log of what someone was working on, and `clientInfo` in
the `initialize` handshake names which agent asked. That is mild on one
operator's machine and is **not** mild in a shared repository: it would become a
record of who investigated what, when. Any implementation must decide, before
writing a line, whether the log is machine-local and gitignored — like the
telemetry it would sit beside — or versioned. ADR-018's amendment reversed a
"stealth" rule for *decisions*; questions are not decisions.

### The plan

1. Append `{ tool, arguments, timestamp, clientInfo }` from `callTool` to
   `.umbra/telemetry/mcp-questions.jsonl`. Gitignored, matching the existing
   telemetry.
2. Decide the aggregation unit. Per module path is the obvious one; per verbatim
   question is too sparse to ever repeat.
3. Only then decide whether it feeds anything — a `umbra metrics` section, or
   `Mandate.knownContext`. **Do not build the consumer first**: this file already
   holds one entry that exists because the injection point was built before the
   data.

---

## A cost estimate before retrieval runs

> **Amendment — 2026-09-10. The premise below was falsified, and the entry is
> kept with the measurement that falsified it rather than rewritten.**
>
> This entry says the real problem is the full scan, and its plan step 1 asks for
> the scan measured on a large repository. Both halves turned out to be wrong in
> the same way. Timed in isolation on this repository: the readiness gate 202.4
> ms, the query embedding 87.2 ms, and **the scan plus fusion 2.2 to 5.6 ms** —
> about one percent of a 293.6 ms round trip. Fixing the scan would have changed
> nothing measurable, so the honest objection recorded here ("fix the scan first,
> and see whether this still wants building") pointed at the wrong thing.
>
> What survives is the shape of the idea, not its target. A caller with its own
> budget still benefits from knowing what an answer cost — but *after* the fact
> costs nothing extra, because `ask_codebase` already emits a provenance header
> and the figure can ride along on a line the answer already sends. That form is
> recorded separately in *A response-cost ceiling, because this gate only has
> floors*, and it does not need a planner. The pre-flight estimate this entry
> proposes is superseded by it.

> Recorded 2026-09-02, branch `2.1.3`. Generated in the same divergence phase and
> not built: it optimizes a path whose real problem is a full scan, and fixing
> the scan may make the estimate pointless.

### The idea

A database query planner reports what a query will cost before running it.
`ask_codebase` could do the same: answer *"this would compare 277 chunks across
19 files, and embedding the query costs one Vertex call"* and let the caller
decide whether to pay.

Under `umbra mcp` the caller is another agent with its own budget
([ADR-019](./adr/ADR-019-turn-cost-is-the-bound-not-tool-calls.md) made cost the
bound for Umbra's own turns; this would extend the courtesy outward).

### What is broken today

`RetrieverService#query` reads every row with a vector and computes
`cosineSimilarity` in JS over each one. Both
[ADR-024](./adr/ADR-024-umbra-as-a-read-only-mcp-server.md) and
[ADR-025](./adr/ADR-025-embeddings-are-chosen-not-assumed.md) record this as an
accepted negative consequence, unfixed. On this repository it is 277 chunks and
imperceptible; it is the bottleneck the moment a server answers several clients
over a large repository.

### The mechanism to reuse

- `RetrieverService#populatedProviders` already runs a cheap `LIMIT 1` probe per
  column — the same shape a count would take.
- `readIndexStamp` already reports `filesIndexed` and `status` without touching
  the vectors.
- `src/core/observability/metrics.ts` for the pricing vocabulary.

### The honest objection to it

An estimate nobody reads is a tool call spent to save a tool call. And the
underlying complaint is the scan, not the ignorance: an indexed vector search
would make the cost small enough that estimating it is wasted work. **Fix the
scan first, and see whether this still wants building.**

### The plan

1. Measure the scan on a large repository, so the problem is a number.
2. Decide between an approximate index in SQLite and an estimate.
3. Only if the estimate survives step 2: expose it as part of the provenance
   header `ask_codebase` already emits, not as a second tool.

---

## Heresy: the read-only layer should not be a LangChain object

> Recorded 2026-09-02, branch `2.1.3`. The mandatory heretical candidate of the
> divergence phase that preceded ADR-024 v1. It contradicts an accepted record
> and is written down for exactly that reason.

### The ADR it contradicts

[ADR-010](./adr/ADR-010-umbra-public-package-and-cli.md) — *one published
package, one `umbra` binary*.

### The idea

`umbra mcp` publishes four read-only tools and instantiates no model. But
importing `listAdrsTool` pulls in `@langchain/core`, because the tool **is** a
LangChain `tool()` object — so the MCP server loads a chat framework in order to
read a markdown index off disk.

The heresy: split the read-only layer into its own package with no LangChain, no
`deepagents`, no `langsmith`. The four capabilities become **plain functions** —
`buildAdrIndex` already is one — and LangChain wraps them at the agent's edge
rather than being the medium they are written in.

### Why it is worth more than an install-size argument

It is also the DDD violation the constitution names first: *the framework stays
behind the port; never leak a framework type into Domain or Application.* Today
the application layer does not merely touch LangChain, it is expressed in it.
Fixing that and fixing the install weight are the same change, which is a strong
signal the change is real.

`src/presentation/mcp/tool-catalog.ts` already declares its own minimal
`InvokableTool` interface to avoid depending on the framework's concrete types —
a workaround that exists because of this defect, and a marker of where the seam
would go.

### What is broken today

Nothing that fails. `umbra mcp` starts, answers, and was verified. This is a
design objection, not a bug — which is why it is recorded rather than acted on.

### The cost, which is the reason it was not chosen

Two packages is two releases and two version numbers.
[ADR-012](./adr/ADR-012-shipped-working-guides-and-consumer-decision-records.md)
carries six amendments as standing evidence of what one artifact drifting from
another costs in this project. ADR-010's single-package decision was not
arbitrary.

### The plan, if it is ever taken

1. Extract the four bodies as pure functions in one commit that changes no
   behaviour and adds no package. **Most of the value is here**, and it is
   reversible.
2. Have both the agent and the MCP adapter call those functions.
3. Only then ask whether a second package is worth its release. If step 1 landed,
   the answer may be no — and that is a fine outcome for a heresy.

---

## Indexed vector search — `vec0`, and the measurement that would justify it

> **Amendment — 2026-09-10. Moved down the roadmap by a measurement it did not
> ask for.**
>
> The plan below waits on the scan measured against a large repository, and that
> is still the right gate for *this* work. But the latency question it belongs to
> now has an answer, and the scan is not where the time goes. On this repository:
> the readiness gate 202.4 ms, the query embedding 87.2 ms, the scan plus fusion
> 2.2 to 5.6 ms, against a 293.6 ms median round trip.
>
> So the ~69 ms this entry extrapolates for 50,000 chunks would be a real cost
> and would still be the third largest thing in the request. Making the readiness
> gate cheap is worth roughly forty times more today and is pure subtraction —
> see *The readiness gate should answer from the stamp, not recount the
> repository*. That does not close this entry; it orders it.

> Recorded 2026-09-02, branch `2.1.3`. Scoped and deliberately not built while
> implementing [ADR-026](./adr/ADR-026-vectors-are-numbers-and-the-database-can-count.md):
> the cheaper half of the fix removed enough of the cost that this became a
> decision to make with numbers rather than a task to do now.

### The idea

`sqlite-vec` offers two modes. ADR-026 uses the scalar one —
`vec_distance_cosine` in ordinary SQL — which moves the arithmetic into C and
returns only the top *k* rows. It does **not** index anything: the scan is still
linear, just with a much smaller constant and no marshalling.

The other mode is `vec0` virtual tables, which give real KNN. That is the only
option here that changes the *order* of the work rather than its constant.

### What is broken today

Nothing is broken, and that is the point of recording rather than doing. Measured
on this repository, after ADR-026:

```
SQL  (vec_distance_cosine + ORDER BY + LIMIT 4)   0.35 ms   258 chunks
extrapolated to 50,000 chunks                       69 ms
```

69 ms of scan on a 5,000-file project is not a problem worth a virtual table and
its synchronisation. **The number that would justify this is a real measurement
on a large repository, not an extrapolation** — every figure in ADR-026 is 258
chunks plus arithmetic, and page-cache behaviour on a 146 MB table may not be
linear at all.

### The mechanism to reuse — do not invent one

- `src/core/state/vector-extension.ts` already loads the extension, memoizes the
  result, and reports a failure once. A `vec0` path needs no new loader.
- `src/core/rag/retriever.ts` already has two ranking paths behind
  `AgentDB.vectorSearch.available`, and `provenance.rankedIn` already reports
  which ran. A third path fits the same seam.
- `chunk_vectors` already stores `dimensions` per row, which is exactly the
  value a `vec0` table needs to be created with.

### The hazard that decides whether this ships

`vec0` tables are created with a **fixed dimension count**, so they are one
table per dimension — and ADR-026 deliberately made a model upgrade a distinct
identity, which means dimensions can differ *within* one provider. So this is
not one virtual table; it is a table per `(dimensions)`, kept in sync with
`chunk_vectors` on every write, plus a rebuild path when it drifts.

A stale KNN index returns confidently wrong neighbours, which is the same class
of failure ADR-025 was written to prevent. **The synchronisation is the whole
risk**, not the query.

### The plan

1. Measure retrieval on a repository with tens of thousands of chunks. Until
   that number exists, this entry is speculation with good arithmetic.
2. If it justifies the work: create one `vec0` table per dimension count, written
   inside the same transaction as `chunk_vectors` so the two cannot diverge.
3. Add a consistency check — row counts per identity, both tables — and treat a
   mismatch as a reason to fall back to the scalar path, loudly. Never silently.
4. Keep the scalar path. It is the reference the indexed path must agree with,
   the same way `rankInJavaScript` is the reference for `rankInSql` today.

---

## Serving MCP over HTTP, and elicitation as the door to writes

> Recorded 2026-09-02, branch `2.1.3`. Both became reachable the moment the
> official SDK was adopted ([ADR-024](./adr/ADR-024-umbra-as-a-read-only-mcp-server.md)
> amendment 6) and neither was built, because each is a decision rather than a
> wiring task.

### The two ideas

**HTTP/streamable transport.** `umbra mcp` speaks stdio, which means one client
per process, on the same machine. The SDK ships an HTTP transport. One Umbra
process could then serve four agents, or a team, or a remote client.

**Elicitation.** ADR-024 constraint 2 says writes are *technically* unavailable
in MCP mode: `requestApproval` suspends by raising a LangGraph `interrupt()`,
which exists only inside a graph run, so there is no channel to ask a human. The
record already names the bridge — MCP elicitation — and the SDK implements it.
That is the prerequisite for anything in this mode that changes a file.

### What is broken today

Nothing. Both are absent capabilities, not defects.

### The hazard, and it is much larger for one than the other

For HTTP: a stdio server is reachable only by the process that spawned it. An
HTTP server is reachable by whatever can open a socket, and ADR-024's **entire**
security argument reduces to constraint 3 — the root is pinned at launch and
never read from a tool argument. That still holds over HTTP, but it stops being
sufficient: authentication, binding address, and rate limiting become questions
this project has never had to answer. `src/presentation/http/` already carries an
`AgentHttpAuthorizer` port for exactly this shape of problem and is the precedent
to read first.

For elicitation: it turns a read-only server into one that can write, which
ADR-024 recorded as *"a much larger decision than this record"*. It should not
be built because it became easy.

### The mechanism to reuse

- `src/presentation/mcp/start-mcp-server.ts` — the startup order, the pinned
  root and the pinned embedding provider are transport-independent.
- `src/presentation/mcp/sdk-server.ts` — `buildSdkServer` already returns a
  server that any SDK transport can be connected to. The transport is one line.
- `src/presentation/http/agent-http.contracts.ts` — `AgentHttpAuthorizer` and
  `AgentRunStore`, the ports the HTTP adapter already defines for host-supplied
  authorization.
- `docs/deferred-work.md` § *`ask_human` with multiple choice* — the analysis of
  the interrupt/resume hazards, which apply unchanged.

### The plan

1. **HTTP first, and read-only only.** `umbra mcp --transport http --port N`,
   bound to loopback by default, with the authorizer port wired before anything
   is exposed beyond `127.0.0.1`.
2. Decide authentication explicitly, in an ADR, before a non-loopback bind is
   possible at all.
3. **Elicitation separately, and last.** It needs its own record, because it
   changes what this mode is allowed to do rather than how it is reached.

---

## Dual ESM/CJS publishing

> Recorded 2026-09-02, branch `2.1.3`. Scoped, priced, and dropped by David in
> the session that fixed `moduleResolution`: it is not needed for anything the
> project does today, and the comparison below is recorded so nobody has to
> price it twice.

### The idea

Publish `@dastbal/umbra` for both module systems, so a consumer can `import` it
as well as `require` it.

### What is broken today

Nothing for this project. The package emits CommonJS, NestJS consumers are
CommonJS, and the binary is CommonJS. This matters only when someone outside the
team wants to consume the library from an ESM project.

### What it would cost — the part worth not re-investigating

Emitting ESM with `tsc` under Node resolution requires **explicit file
extensions on every relative import** (`./foo.js`), and this codebase omits them
throughout — hundreds of imports.

| Option | Cost |
|---|---|
| `module: "esnext"` + `moduleResolution: "bundler"`, plus a post-emit script that appends `.js` to relative specifiers | ~40 lines of build script. **Does not touch source.** `tsc` keeps emitting the decorator metadata NestJS dependency injection needs |
| `tsup` / esbuild | Simpler config, but **esbuild does not emit `emitDecoratorMetadata`**, which Nest DI relies on. Would additionally need the SWC plugin |
| Add extensions to every source import | Hundreds of files touched for a packaging reason. The most invasive, and the noisiest in history |

The first is the recommendation if this is ever taken. `bin.umbra` must keep
pointing at the CommonJS output — it needs a shebang and `require` — and
`main`/`types` must stay for older resolvers, with an `exports` map added
alongside.

### What was done instead, and why it was the valuable part

`tsconfig.json` moved from `moduleResolution: "node"` (Node 10 resolution, which
does not read `exports` maps) to `"Node16"`. One line, no output change, and it
is what makes TypeScript see packages the way Node does. It immediately caught a
real portability bug — `uuid@13` being ESM-only with no `require` condition,
under an `engines: node >= 20` declaration — that had been invisible for as long
as the old resolution was in place.

### The plan, if it is ever taken

1. Confirm someone actually needs it. A dual build with no ESM consumer is two
   artifacts to keep in sync for nobody, and ADR-012's six amendments are the
   standing evidence of what that costs here.
2. Write the post-emit specifier script, and test it by `import`ing the built
   ESM output from a scratch project — not by reading the emitted files.
3. Keep the CommonJS path byte-identical to today's, so Nest consumers cannot be
   affected by a change made for someone else.

---

## A fixture index, so retrieval quality can be a CI gate

> **Implemented 2026-09-09.** `scripts/build-retrieval-fixture.mjs` builds it,
> `src/core/rag/retrieval-gate.spec.ts` scores it, and `.github/workflows/test.yml`
> runs it. The entry is kept rather than deleted: the investigation below is what
> the implementation was built from, including the two options weighed for query
> vectors — the pre-computed set was chosen, and it does freeze the query set as
> predicted. See the 2026-09-09 amendment to ADR-031 for what it measures and
> what it deliberately cannot.

> Deferred 2026-09-08 while implementing ADR-031 phase 1. The runner, the
> corpus and the scoring all landed; only the offline path did not.

### The idea

Commit a small fixture index — a SQLite file with `code_chunks`, `chunk_vectors`
and the FTS5 table already populated for a handful of source files — so
`bench-retrieval` can score ranking, rank fusion and the abstention policy in
GitHub Actions with no provider, no network and no credentials.

### What is actually missing

`scripts/bench-retrieval.mjs` launches the compiled MCP binary, which resolves a
live embedding provider on startup. In CI that means either an Ollama daemon or
Vertex credentials, and neither exists there. `.github/workflows/test.yml`
therefore runs type-check, jest and build, and nothing that would notice a
retrieval regression.

This is the gap that makes every quality number in this repository a local,
manual observation. The corpus and the metrics are now under version control;
what is not is the ability to fail a pull request over them.

### The mechanism to reuse

`chunk_vectors` already keys on `(chunk_id, provider, model)`, so a fixture is a
legitimate identity rather than a special case — `provider: 'fixture'` with its
own model name cannot be confused with a real one, by construction (ADR-026).
`vector-codec.ts` writes the BLOBs. `retrieval-metrics.ts` is already pure and
takes the returned paths, so it needs no change at all.

The query vector is the remaining piece: scoring a query requires embedding it.
Either the fixture stores pre-computed query vectors keyed by corpus id — which
makes the run fully offline but freezes the query set — or the CI job embeds
with a tiny deterministic stub, which tests fusion and abstention but not the
model. The first is the honest one: it measures ranking, and says so.

### Plan

1. Build the fixture from this repository with `provider: 'fixture'`, over a
   subset of files large enough that the corpus positives have somewhere to
   land and small enough to commit.
2. Store one pre-computed query vector per corpus case beside it.
3. Add a `--fixture` path to the runner that skips provider resolution and the
   readiness gate.
4. Add the job to `test.yml` as a **reporting** step first, and only make it
   blocking once a few runs establish what the normal variance is. A gate that
   fails on noise gets disabled within a week.

---

## A corpus health check, because a negative case rots silently

> Deferred 2026-09-08 after the abstention fix. The failure was observed, the
> guard was not built.

### The idea

`bench-retrieval` already refuses to score a corpus the index cannot answer —
`assessCorpusCoverage` reports expected paths with no chunk. The mirror check
for negatives does not exist: report any negative case whose every subject term
is present in the indexed source, because such a case can no longer prove
anything about abstention.

### What is actually missing

A negative case is only a negative while the repository stays ignorant of its
subject. That property is destroyed by ordinary work, and silently:

- `negative-prometheus` stopped being a negative because the TSDoc of
  `unknown-terms.ts` — written to explain the very defect it proved — named the
  term. The repository then contained it, the rule correctly called it known,
  and that case was the one negative still failing the next run. Cause and
  effect were three hours apart.
- `negative-redis` was never catchable by term absence at all: `redis` genuinely
  appears in this repository's source. That one is a fair hard case, not rot,
  and the check must be able to say so.

Without the guard, a corpus quietly loses its negatives and the correct
abstention rate drifts up for no reason anyone can see.

### The mechanism to reuse

`findUnknownTerms` already answers exactly this question, and
`assessCorpusCoverage` is the precedent for the reporting shape — a `null` where
a rate has no denominator, a named list where something is missing.

### Plan

1. Add `assessNegativeHealth(db, cases)` beside `assessCorpusCoverage`: for each
   negative, the subject terms the index does not contain. Zero such terms means
   the case is unprovable.
2. Print it in the runner's preflight and store it in the report, next to
   coverage.
3. Allow a case to declare `unprovableByAbsence: true`, so a deliberately hard
   negative such as `negative-redis` is not reported as rot every run.
4. Consider failing the run when a case that used to be provable stops being
   so — that requires comparing against the previous committed report, which is
   the first thing the results directory makes possible.

---

## Routing a turn by its size, which ADR-002 currently forbids

> **Implemented 2026-09-09** as an amendment to
> [ADR-002](./adr/ADR-002-model-routing-and-bounded-analysis.md), which is
> exactly what step 1 below asked for: the decision came first, and the answer
> was the third option — route automatically only when the operator expressed no
> explicit choice, and always announce it. The entry is kept rather than deleted
> because the reasoning about *why it was not simply an improvement* is what a
> future reader needs before touching the resolution order again.
>
> Noticed 2026-09-10, still marked deferred a day after it shipped. This file's
> own header says an implemented entry moves out and becomes an ADR; the second
> half happened and the first did not, which is the small drift worth naming.

> Deferred 2026-09-08 while finishing ADR-031 phase 2. Named as a phase-2 goal
> in that record; deliberately not built, because building it would contradict
> an accepted decision without saying so.

### The idea

With a pre-call token count, an oversized request could be sent to a model that
can hold it — *"this prompt is 40k, it does not fit the local model, send it to
the cloud one"* — instead of failing.

### Why it is not simply an improvement

[ADR-002](./adr/ADR-002-model-routing-and-bounded-analysis.md) fixes model
resolution as `--model` > `AGENT_MODEL` > project profile, and says an
orchestrator role resolves its own profile without reading the environment
variable. Size-based routing inserts a rung the operator did not write, above
the one they did. A user who typed `--model ollama:llama3.2` for privacy would
silently have their prompt sent to Vertex — the failure being that it is
*silent*, not that it is wrong.

So this is not a phase-2 implementation detail. It is an amendment to ADR-002,
and it needs David's decision on the question ADR-002 answered: whether anything
may override an explicit model choice, and whether the operator is asked first.

### What is actually missing besides the decision

No per-model context window exists anywhere in the codebase. `DEFAULT_LLM_PRICING`
in `src/core/infrastructure/config/default-pricing.ts` is the pattern to copy —
a shipped table of published facts with a project-local JSON override, and the
lesson already recorded there that a missing entry must not read as zero.

### Plan

1. Get the decision on ADR-002 first. Options worth putting to David: refuse and
   explain; ask for approval once per session; route automatically only when the
   operator expressed no explicit choice.
2. Add `contextWindow` beside pricing, with the same override mechanism and the
   same treatment of a missing entry — unknown, never "unlimited".
3. Early rejection is the half that needs no decision: a request already known
   to exceed the window can be refused before the round trip, whatever the
   routing policy turns out to be. It is blocked only on the window table.

---

## Retrieval without vectors, and the number that closed it

> **Closed 2026-09-10 by measurement**, not by argument. Kept rather than
> deleted, because the reasoning is what stops this being re-proposed every time
> the embedding machinery costs someone an afternoon — and because the *shape* of
> the answer is more useful than the verdict.
>
> Recorded 2026-09-10, branch `2.2.5`. The heretical candidate of the divergence
> ritual that followed the 2.2.5 retrieval audit, in its lateral form: the
> "delete the load-bearing thing" lens applied to the vectors.

### The idea

Remove the semantic branch. `ask_codebase` answers from FTS5, the dependency
graph and TSDoc enrichment alone.

The appeal was never the ranking, it was everything downstream of it. The launch
probe, the index stamp, the writer lease, the per-identity vector rows, the
dimension checks, the reindex-on-model-change and the readiness gate all exist to
keep vectors consistent. Delete the vectors and that apparatus becomes
unnecessary: boot is instant, there is no coverage to verify, no provider to
resolve. This file already carried two milder versions — *FTS-only fallback* and
*a semantic-opt-in default* — both waiting, per the *Long-context Ollama
embedding profiles* entry, on "a measured retrieval problem".

### What the measurement said

`scripts/bench-fts-only.mjs`, calibration split, commit `e72d7a8`, 169 files and
1,022 chunks, both arms under a 100% reachable ceiling with 10 of 10 negatives
provable:

| Arm | hit@4 | mrr |
| --- | --- | --- |
| hybrid | 0.867 | 0.683 |
| fts-only | 0.667 | 0.585 |

Twenty points. **The shape of the loss is the part worth keeping.** Of the nine
positives only the vectors rescue, eight were *answered* by the lexical arm — it
returned files, confidently, and they were the wrong ones. Only one abstained. So
the vectors are not buying recall; they are buying the difference between a
confident wrong answer and a right one, which is the failure mode that costs a
consuming agent most. And in 45 positives there was no case where fusion
displaced a correct lexical hit, so the fusion is not taxing the lexical arm.

Two points of the twenty are an artefact rather than ranking: with no semantic
branch the `hybrid` evidence class is unreachable, so `hasGroundedEvidence` can
only ground on `lexicalExact` and abstention tightens by omission. The control
arm reports both arms so that side effect is never credited to the vectors.

### What did not survive the same measurement

The *reason* the apparatus felt expensive was latency, and that was
misattributed. Timed in isolation against the same index: the readiness gate 202
ms, the query embedding 87 ms, the search itself 2.2 to 5.6 ms. The embedding is
the smaller half of the cost and the search is about one percent of a round trip.
The vectors were being blamed for a bill the readiness gate had run up.

### What would reopen it

A repository where the gap narrows. Twenty points is this corpus on this
repository, whose identifiers are unusually descriptive — a codebase with terse
or non-English names gives FTS5 much less to match on, and it is not obvious
which way that moves the number. `--root` makes that run one flag away, and the
corpus would need its own expected paths for the new repository.

The milder forms stay live. An opt-in `--no-semantic` for a consumer who wants
instant boot and accepts 0.667 is a product decision this measurement does not
settle; it only says that consumer is trading twenty points, and now they can be
told so.

---

## The readiness gate should answer from the stamp, not recount the repository

> **Implemented 2026-09-10**, and not the way this entry planned it. The answer
> turned out not to be the stamp: it was noticing that two of the eleven
> conjuncts answer *is the index current?* while the gate needs *can the index
> answer?*. `inspectIndexServeability` drops those two, 401 ms became 52 ms, and
> an edited file no longer refuses the question. Recorded as ADR-024 amendment
> 16. Kept rather than deleted because the hazard analysis below is what the
> implementation had to satisfy, and because the step it names first — establish
> which conjuncts can change without the stamp or the lease changing — is
> exactly what produced the design.

> Deferred 2026-09-10, branch `2.2.5`. The largest single latency win available,
> and the only thing in this file that is pure subtraction. Not built in the
> session that measured it, because it changes when Umbra is allowed to say
> "ready", and getting that wrong is the failure ADR-025 exists to prevent.

### The idea

`readReadiness` should read the index stamp and the lease. The full integrity
sweep should run in `umbra doctor --index`, where an operator asked for it.

### What is actually true today

`src/presentation/mcp/start-mcp-server.ts` calls `inspectIndexIntegrity` on
**every** `ask_codebase` call. That opens a second SQLite connection, re-runs
`WorkspaceDiscoveryService.discover()`, and md5-hashes every discovered source
file — to re-derive facts `.umbra/index.identity.json` already records.

Measured on this repository, 169 files: **202.4 ms median over six runs**
(173.5 to 316.1) against a 293.6 ms median round trip, in which the search itself
is 2.2 to 5.6 ms. The cost is per call and scales with the file count of the
repository being served, not with the question being asked.

It also explains a finding an audit misattributed. `query_nest_graph`,
`query_dependency_graph` and `run_integrity_check` do not pass through this gate
and `ask_codebase` does. That, not the embedding call, is the two-orders-of-
magnitude latency gap between them.

### The mechanism to reuse — do not invent one

- `src/core/rag/index-stamp.ts` already records provider, model, dimensions,
  `discoveredFiles`, `coveredFiles` and `status`, and ADR-030 already defines a
  `complete` stamp as one whose facts agree.
- `src/core/rag/index-run-lease.ts` is the existing invalidation signal: a
  single-writer lease with a heartbeat, stale after 90 s. A write in flight is
  exactly the state a cheap check must still notice.
- `src/core/tools/utils/bounded-read.ts` is the precedent for an env-overridable
  bound, if the cheap path ends up wanting a re-check interval.

### The hazard that decides whether this ships

A memoized "ready" over an index that has since broken. ADR-024 made semantic
retrieval retryable precisely so a not-yet-ready index is a retry rather than a
wrong answer, and this trades some of that certainty for latency. The question to
answer before writing code is not *how do we cache it* but **what must still
invalidate it**: a lease becoming active, a stamp whose file counts moved, a
schema change. Anything that can go stale without one of those three firing
becomes a wrong answer with a fast response time.

### Plan

1. Establish which of `inspectIndexIntegrity`'s conjuncts can change without the
   stamp or the lease changing. That set is the whole design.
2. Split the function: a cheap readiness read for the hot path, the existing full
   sweep for `umbra doctor --index` and `get_index_status`.
3. Keep the full sweep reachable and keep its message. "Run umbra doctor
   --index" is only useful advice while the thing it names still does the work.
4. Measure the same three stages again. A change that does not move the 202 ms
   did not do what it was for.

### Cost

Free at runtime, which is the point. The cost is the reasoning in step 1, plus a
spec per invalidation path.

### What would make it worthless

Making it cheap by making it wrong. If the honest answer to step 1 is that most
conjuncts *can* drift silently, the correct outcome is to keep the sweep and
cache it behind a short TTL instead — slower to write, and still worth 200 ms.

---

## The answer as a diagnostic, not a photocopy

> Deferred 2026-09-10, branch `2.2.5`. Produced by the ideation ritual's "borrow
> from another discipline" lens, taking a compiler's diagnostics. The cheap first
> step is a bug fix and should be taken on its own; the rest changes what every
> consuming agent reads and needs an ADR.

### The idea

A compiler does not hand you the file. It hands you a span, a message, and a
`note:` pointing at the related location. `ask_codebase` would return, per hit:
the path and line range, **the reason it matched**, and a note the dependency
graph can already produce. The body stays reachable through `safe_read_file`.

The elegance is that it *removes* code. If the answer emits only signal with its
reason, there is no volume left to cap — the filter and the ceiling stop being
needed, because the photocopy is gone.

### What is actually true today

- **The reason is already computed and thrown away.** `hybrid-ranking.ts` derives
  `evidence` and `lexicalExact` in order to decide whether to abstain, and
  `RetrieverService` never emits either. It is the most informative fact about a
  hit and the only one that does not reach the caller.
- **The skeleton is emitted raw and uncapped.** `RetrieverService` interpolates
  the stringified `file_registry.skeleton_signature` JSON, bypassing the
  `formatSkeleton` that exists in `src/core/tools/analysis-tools.ts`. Three lines
  above, the graph-derived import list is capped at five and filtered to
  first-party paths. One function, two lists, opposite discipline.
- **Imports travel twice.** `NestChunker#extractClassContext` prepends every
  import declaration to each `class_signature` chunk, so they appear once as
  skeleton JSON and once inside the snippet. In `src/core/llm/provider.ts` that
  chunk is 289 tokens of which 136 are the import block.
- **Nothing bounds the response.** No max-tokens, max-files or truncation
  constant exists on any MCP tool result. `read_file` has
  `DEFAULT_MAX_READ_TOKENS` at 6,000; `ask_codebase` has nothing.

Measured across 169 skeletons here: 15,710 tokens, 93 per file, of which 14.2%
is external package imports and 43.3% is the JSON envelope. On a consumer
repository importing a sixty-name Zoho SDK list the same block reached 65% of one
answer — so the defect is repository-independent and its price is not.

### The mechanism to reuse — do not invent one

`hybrid-ranking.ts` for the reason. `formatSkeleton` for the rendering.
`dependency_graph` for the notes, which is one query. `bounded-read.ts` for the
shape of an env-overridable bound, if one is still wanted afterwards.

### The hazard that decides whether this ships

An agent that receives spans and immediately calls `safe_read_file` four times
spends more in total than one handed the code. That is measurable before building
anything: count `safe_read_file` calls per turn following an `ask_codebase` call
in `.umbra/telemetry/`. If the number is already high, this makes the round trip
cheaper and the turn more expensive.

ADR-011's freeze also applies, and is narrower than it looks: it covers what
`generateSkeleton` **stores**, not what the retriever **renders**. Changing the
rendering needs no reindex; changing the chunker does.

### Plan

1. **Take the cheap fix separately.** Filter the rendered skeleton to relative
   specifiers and cap it, the way its sibling three lines above already is, and
   stop duplicating imports into `class_signature` content. No stored shape
   changes, no reindex, defensible on its own.
2. Measure `safe_read_file`-after-`ask_codebase` from telemetry. This decides
   whether step 4 is an improvement or a transfer.
3. Emit `evidence` and `lexicalExact` per hit. Cheap, additive, and useful even
   if nothing else here is built.
4. Only then the span-and-note form, as an ADR, with the body behind an opt-in
   argument rather than removed.

### Cost

Steps 1 and 3 are small. Step 4 changes what every consuming agent reads, which
is why it is last and why it is a record before it is a commit.

### What would make it worthless

Truncating the file that mattered. A short answer that looks complete is worse
than a long one — which is why the audit's original "just cap it" framing was not
enough by itself. A cap without a reason field makes the answer smaller and no
more legible.

---

## An abstention that asks instead of refusing

> Deferred 2026-09-10, branch `2.2.5`. Produced by the ideation ritual's "invert
> who asks" lens. **It contradicts an accepted decision** and needs its own ADR
> before any code: ADR-024 names elicitation as the door to writes and says
> plainly that it should not be built because it became easy.

### The idea

When `findUnknownTerms` finds a subject term the index has never contained, Umbra
currently names it and stops. Instead it would **ask** — *did you mean
`checkpoint`?* — through MCP elicitation, and store the answer as an approved
alias.

Every abstention today discards information. This is the only mechanism in the
project that would let the vocabulary gap close itself.

### What is actually true today

- The learning mechanism exists and is unreachable. `RetrievalMemoryService`
  implements `approve`, and **nothing on the MCP surface can call it**. A consumer
  running `umbra mcp` is told which term is missing and given no route to resolve
  it.
- ADR-028's residual gap has two classes and only one is morphological. `-ly` and
  `-ion` are derivation, which no addition to `INFLECTIONS` reaches; a synonym is
  what ADR-029's aliases are for.
- **There is an unrecorded defect on this exact path that must be fixed with it,
  or before it.** `knownTerms()` exempts only `trigger_terms`, while `expand()`
  appends `context_terms` into the query the gate then probes, and `approve()`
  validates that `verifiedPaths` is non-empty but never validates that the
  context terms exist in the index. An approved alias carrying an absent context
  term therefore makes **every** query hitting that trigger abstain permanently,
  and the clarification retry re-expands, so it cannot recover. Shipping an
  alias-writing path on top of that turns a latent trap into a reachable one.

### The mechanism to reuse — do not invent one

This file's *`ask_human` with multiple choice* entry carries the interrupt and
resume analysis, and both hazards apply unchanged: `interrupt()` throws to
suspend, so the tool body re-runs from the top, and any `try/catch` between the
tool and the graph must rethrow the suspension first. The MCP SDK implements
elicitation, adopted with ADR-024's sixth amendment.

### The hazard that decides whether this ships

ADR-024 constraint 2 makes writes technically unavailable in MCP mode, and that
record calls widening it *"a much larger decision than this record"*. The
distinction this idea rests on is that **a clarifying question is not a write**.
That distinction is either sound, or it is the first step of an argument for
arbitrary writes. It has to be settled in a record before it is settled in code.

Second hazard: a client without elicitation must end up no worse off than today,
so the refusal path stays and the question is an enhancement rather than a
replacement.

### Plan

1. Fix the `context_terms` defect first, on its own. It is a bug today, with or
   without this feature.
2. Write the ADR: is a clarifying question a write? If yes, this stops here.
3. Only then, elicitation on the abstention path, with the current refusal as the
   fallback for clients that lack it.
4. Store the answer with provenance, and require an alias to name an indexed
   term, so step 1's trap cannot be re-entered through the front door.

### Cost

One extra round trip per abstention, on a path that currently costs no provider
call at all — ADR-028 put the gate before the embedding on purpose. Worth stating
plainly: this makes the cheapest path in retrieval more expensive, in exchange
for it teaching the index something.

### What would make it worthless

A model that answers its own clarifying question. If the client resolves the
elicitation without a human, the alias store fills with a model's guesses about
vocabulary, and an approved alias is trusted forever. It must be answerable only
by a person, or this is worse than abstaining.

---

## The sentences in the test titles as their own chunk type

> Deferred 2026-09-10, branch `2.2.5`. **Contradicts ADR-030** and needs an
> amendment to it, not a quiet implementation. The original heretical candidate
> was "index the test files"; this is David's sharper form, and the sharpening is
> what makes it survivable.

### The idea

Do not index the test's code. Index its **sentences**.

A test title is a natural-language sentence describing a behaviour, and a
semantic query is a natural-language sentence about a behaviour. The
implementation is code; the title is prose. For matching a question the title
wins — and the titles are already written, already maintained, and already
verified by CI.

David's framing is why this is worth more than a usage index: the specs are where
a repository writes down **the cases that break it**. That is the one thing no
other artifact in the tree records executably.

### What is actually true today

`isIndexableSource` in `src/core/config/workspace-discovery.ts` drops
`.spec.ts`, `.test.ts`, `.d.ts` and the story files, and one predicate serves
both the semantic index and the dependency graph. So no test content is indexed
at all, here or in a consumer's repository — and the graph consequence is now
recorded in ADR-030's 2026-09-10 amendment.

### The mechanism to reuse — do not invent one

ADR-029 is the precedent and it is nearly exact: TSDoc enriches code metadata as
its own labelled contribution *without becoming code evidence*. A test title
wants the same treatment — a distinct chunk type, labelled in the answer, so it
can match a question without being presented as source.

`ts-morph` already parses these files whenever they are enumerated, and the call
expression is trivial to reach. `assessNegativeHealth` already exists to catch
the corpus damage this could cause.

### The hazard that decides whether this ships

**The negatives.** This file already records a negative dying twice because a
comment written to explain a defect named the term that case depended on, three
hours after the commit. Test titles introduce far more English vocabulary than
source does, so indexing them could rot several negatives at once — and a rotted
negative raises the correct-abstention rate for free, which is the exact
mis-measurement ADR-031 was written about.

`assessNegativeHealth` would catch it, but only if it is run *before* the change
lands and compared after. Otherwise the corpus quietly stops testing abstention.

### Plan

1. Run `assessNegativeHealth` now and record which negatives would rot if test
   titles entered the index. If the answer is most of them, the corpus needs new
   negatives before this is possible at all.
2. Decide the scope: which call expressions count, and whether the enclosing
   describe chain is joined into the sentence. A joined chain reads better and is
   more vocabulary.
3. Amend ADR-030 with the decision, since it changes the scope that record sets.
4. Index as a distinct chunk type, labelled in the answer as a test expectation
   and never as source.
5. Score it. A new chunk type that does not move Hit@4 is index weight for
   nothing.

### Cost

Small in tokens — a title is ten words, not a file, so this does not double the
index the way indexing test bodies would. Real in churn: titles change more often
than implementations, so more files go stale more often.

### What would make it worthless

A repository whose test titles are all "works". The value is entirely in the
prose quality of someone else's test names, which this project cannot control and
should not assume. Worth measuring on a consumer repository before believing the
number from this one, where the titles happen to be unusually descriptive.

---

## A response-cost ceiling, because this gate only has floors

> **Amendment — 2026-09-14.** ADR-032 now makes retrieval evidence, typed result
> envelopes, and MCP JSON explicit and independently observable. No ceiling was
> introduced: clients may consume both `structuredContent` and its text fallback,
> so the pending measurement must count that effective duplication rather than
> assuming the artifact or structured field is free.

> Deferred 2026-09-10, branch `2.2.5`. Named as the follow-up metric in ADR-031's
> 2026-09-10 amendment. Not built alongside the measurement that motivated it,
> because a ceiling calibrated on one repository repeats the mistake ADR-028
> named.

### The idea

`measureResponseCost(text)` beside `retrieval-metrics.ts`, reported per case by
both benchmark runners, with a token ceiling asserted in the CI gate.

### What is actually true today

`retrieval-gate.spec.ts` asserts a hit floor, a false-abstention cap and a
correct-abstention floor. Nothing asserts anything about the **size** of an
answer, and nothing anywhere bounds it.

That is why a skeleton block reaching 65% of an answer on a consumer repository
was something an audit found rather than something the build reported.
`js-tiktoken` is already a dependency, so the counting costs nothing new.

### The mechanism to reuse — do not invent one

`retrieval-metrics.ts` is already pure, type-checked and covered, and
`bench-retrieval.mjs` states the rule this must follow: scoring lives under test
because a metric that drifts silently turns every later number into a false
report of progress. `src/core/observability/metrics.ts` holds the pricing
vocabulary. Report keys must be **additive**, so the five committed reports keep
parsing.

### The hazard that decides whether this ships

A ceiling fitted to this repository. ADR-028 rejected a threshold "fitted to one
repository" in favour of a property the index answers about itself, and a token
ceiling has no such self-answering form: it is a constant, and it will be wrong
for somebody. It needs calibrating against at least two repositories with
different import profiles, and it should start as a **reported** number rather
than a failing assertion, the way the fixture gate did.

### Plan

1. `measureResponseCost` plus spec: total, signal, framing and external-import
   tokens, and the file count. Classify an external import by the rule
   `extractDependencies` already uses — the specifier does not start with a dot.
2. Additive keys in both runners' reports.
3. Report in CI for a few runs to establish variance. A gate that fails on noise
   is disabled within a week.
4. Only then a ceiling, calibrated on two repositories and recorded with both.

### Cost

Nothing at runtime: this measures reports, not requests. If the provenance header
ever carries the figure to the caller, that is a handful of tokens on a line the
answer already sends.

### What would make it worthless

Measuring the wrong thing. A total conflates the code the caller asked for with
the envelope it arrived in, and only the second is waste. The signal and framing
split is the whole value — a single total would let the skeleton grow inside a
passing ceiling as long as the snippets shrank.

---

## Skipping the index run when there is provably nothing to index

> Deferred 2026-09-10, branch `2.2.5`. Scoped, measured, and **not built,
> because the measurement stopped justifying it while it was being taken.** The
> reasoning is recorded because the idea is obvious enough that someone will
> propose it again.

### The idea

`warmIndexInBackground` runs a full `indexProject()` on every launch unless
`--no-index` is passed. The `--no-index` branch already asks the right question —
`hasDurableCoverage`, which is `inspectIndexIntegrity(...).healthy` and therefore
true only with no stale file, an agreeing stamp, a free lease and no missing
vectors. Ask it on every launch, and skip the run when the answer is yes.

### Why it was dropped

**Its benefit is inside the noise.** Spawn to `get_index_status` reporting
`ready`, alternating routes on the local binary:

```
with-index   163,430 ms   (a genuine reindex: source files had just changed)
no-index       7,821 ms
with-index    13,907 ms   (steady state, nothing to do)
no-index      12,867 ms
```

The 163 s sample is not an outlier to discard, it is the case working correctly —
several files were stale and were re-embedded. But the steady-state comparison
that matters is 13.9 s against 7.8 and 12.9, and the spread between two runs of
the *same* route is larger than the difference between the routes.

**The problem it was proposed to fix turned out to be somewhere else.** It was
scoped as part of the connect-timeout work, on the assumption that boot cost
delays the handshake. It does not: the transport connects before warm-up. The
handshake's real costs were the launch route and an eager import, both measured
and both closed — see ADR-024 amendment 15.

**And it would have broken the delivery path for a fix landing the same day.**
`indexProject()` is where `backfillNestGraph` and `backfillDependencyGraph` run.
Both exist precisely to repair derived data that no content hash can detect, so
skipping the run on a healthy index is exactly the case where they must still
happen — and a healthy index is every working install. Re-exports would have
reached no existing graph.

### The mechanism to reuse, if it comes back

- `hasDurableCoverage` in `src/presentation/mcp/start-mcp-server.ts` is the
  predicate, already trusted on the `--no-index` path.
- The short-circuit belongs **inside** `IndexerService#indexDiscoveredProject`,
  after the backfills and before the per-file work — not in the caller, which
  cannot see the backfills.

### What would make it worth building

A measurement with less variance than the effect. That means timing the phases
inside `indexProject()` rather than the whole launch: discovery, the `md5` sweep
through `FileRegistry`, the lease, the stamp writes. If one of them is seconds
on a healthy index, skip that one — which is a smaller and better-aimed change
than skipping the run.

---

## `query_nest_graph` is published over MCP and unreachable from the agent

> Recorded 2026-09-10, branch `2.2.6`. Found while restructuring the README,
> which advertised the tool in the `deep` agent's tool list. Not fixed there,
> because deciding whether the agent should have it is a capability decision and
> the README fix only had to stop lying.

### What is actually true today

`queryNestGraphTool` is imported by `src/presentation/mcp/tool-catalog.ts` and by
nothing else outside its own module. It is **absent from
`CAPABILITY_REGISTRY`** in `src/core/agent/agent-kernel.ts`, whose own TSDoc
calls that registry "the single source of truth for built-in capabilities and
their concrete tools".

So the MCP server publishes it and the agent cannot call it. The README listed it
among the `deep` mode's tools until 2026-09-10.

This is the same shape ADR-013 recorded twice and the registry's own comment
records a third time: `queryDependencyGraphTool` was reachable "only by importing
it directly", which is why `read_dependency_graph` exists as a capability. The
Nest graph tool never got that treatment.

Note that `read_dependency_graph` exists and `simple` mode still does not declare
it — the capability is registered, and no mode asks for it. Whatever is decided
here should decide that too, since it is one question asked about two tools.

### The mechanism to reuse — do not invent one

`CAPABILITY_REGISTRY` and the comment above `read_dependency_graph`, which
already argues the shape of the answer: the graph query "costs nothing and needs
no credentials", so it was made its own capability rather than folded into
`search_codebase`, which also grants a tool that writes. A `read_nest_graph`
capability is the same argument for the same kind of tool.

`prompt-tool-contract.spec.ts` is the guard that would have caught the README's
version of this if a README were a prompt. It checks that every tool a mode's
prompt names is a tool that mode declares.

### The hazard that decides whether this ships

Adding a capability is not free: it is another tool in the model's catalog on
every turn, and ADR-019 measured that a turn's cost is the bound. The honest
question is not "can the agent have it" but "does the agent's work need it" — the
`deep` prompt never told the model to use it, so nothing regressed while it was
missing, which is weak evidence that nothing needs it.

The opposite reading is equally available: the agent has spent whole turns
reading module files by hand to answer a wiring question this tool answers in one
SQL query, and nobody measured that either.

### Plan

1. Count it before adding it. `ask_codebase` calls per turn and
   `safe_read_file`-after-`ask_codebase` are already in
   `.umbra/telemetry/interactive-turns.jsonl`; a wiring question answered by
   reading three module files is visible there.
2. If it earns a place: register `read_nest_graph` beside
   `read_dependency_graph`, with the same reasoning, and decide in the same
   change whether any mode declares either.
3. Extend `prompt-tool-contract.spec.ts` if a prompt begins naming it.

### What would make it worthless

Registering it and having no prompt mention it. That is the state
`read_dependency_graph` is in right now: a capability nothing asks for, which
costs a line in a registry and buys nothing. Better to leave the tool MCP-only
and let the client ask, which is what the README now says.

---

## Broader repository artifacts after authoritative Prisma schemas

> Deferred 2026-09-17 after ADR-033 shipped `prisma/schema.prisma` as the first
> non-TypeScript retrieval artifact. The consumer finding was real, but it does
> not make every text file equally authoritative.

### The idea

Add separately declared artifact adapters for current migration state, OpenAPI
contracts, deployment manifests, and curated configuration. Pair them with a
business-guarantee corpus that expects the enforcing artifact and the code that
reacts to it, rather than scoring a generic file hit.

### What is actually missing

Umbra now finds Prisma constraints, but it cannot say that a historic SQL
migration is still current, that a YAML value is effective in a deployment, or
that a JSON document is a generated by-product. It also returns evidence files;
it does not yet model a verified relationship such as “this `P2002` handler is
caused by this unique constraint.”

### The mechanism to reuse

`WorkspaceDiscoveryService` already assigns an artifact kind, and
`PrismaSchemaChunker` shows the safe shape: declared location, parser-owned
chunks, an explicit label in the public DTO, and no dependency-graph inference.
The committed retrieval corpus and gate from ADR-031 are the place to measure
the new evidence, not an anecdotal consumer session.

### Plan

1. For each candidate format, decide its authority rule before writing a parser:
   current schema, versioned history, generated output, or operator intent.
2. Add one artifact adapter at a time, with an explicit allowlist and a labelled
   result; never recursively index file extensions.
3. Add consumer fixtures for idempotency, monetary precision, relations, and a
   deliberately stale migration so retrieval cannot mistake history for truth.
4. Only after those fixtures pass, evaluate a first-class `guarantees` query
   that links enforcing configuration to code that handles its outcome.

---

## MCP progress for background index warm-up

> Deferred 2026-09-17 after reviewing the SDK's progress contract and Umbra's
> deliberate post-handshake warm-up design.

### The idea

Show MCP clients meaningful warm-up progress instead of an apparently idle
server while embeddings and durable coverage are being prepared.

### What is actually missing

MCP `notifications/progress` belong to one request and require that caller's
`progressToken`. Umbra intentionally starts warm-up after `initialize`, in the
background, so there is no long-running request to associate with those
notifications. Sending uncorrelated progress would not reliably reset a
client's request timeout and would misrepresent protocol semantics. This is
distinct from request-bound tool liveness: active tool calls now report their
own progress when the caller supplies a token.

### The mechanism to reuse

`McpIndexLifecycle` already exposes exact phases through `get_index_status` and
`umbra://index-status`; `IndexerService` already emits file and batch progress
to the lifecycle observer.

### Plan

1. Observe whether clients actually poll `get_index_status` or render its
   resource during warm-up.
2. If visibility remains insufficient, design either a request-bound
   `wait_for_index` operation with a `progressToken`, or a resource-update
   notification contract that clients demonstrably consume.
3. Test the client-visible sequence and timeout behaviour before advertising it
   as a startup fix.

---

## Local artifact-policy adviser

> Deferred 2026-09-18 while implementing ADR-035's deterministic workspace
> inventory and literal evidence search.

### The idea

Offer an optional local LLM adviser that proposes **artifact classes** worth
adding to semantic indexing after `inspect_project` reports the repository's
safe type inventory.

### What is actually missing

Umbra can now distinguish that a workspace contains Prisma, SQL, JSON, YAML,
and contracts without indexing their content. It still needs a human decision
and an artifact-specific parser before any of those classes becomes semantic
evidence. An adviser must not turn extension frequency into permission to index
history, generated output, or secrets.

### The mechanism to reuse

`inspect_project` supplies metadata-only counts and exclusion reasons;
ADR-033's Prisma adapter supplies the pattern for one authoritative artifact
class, explicit labelling, and a consumer fixture that tests stale history.

### Plan

1. Give the local adviser only paths, extensions, sizes, and inventory counts —
   never file bodies or secret-like paths.
2. Have it return a proposed artifact class, rationale, risk, and the parser
   work required; it may not alter `umbra.json` or indexing policy.
3. Require an operator decision, a new ADR or amendment, a parser, a labelled
   result contract, and a benchmark fixture before activating one class.

---

## The budget guard should see the floor it guards

> Deferred 2026-09-23 after `npm run bench:floor` measured the per-turn floor at
> the provider boundary. The larger half — `write_todos` — was compacted the same
> day (ADR-031, 2026-09-23 amendment). This is the half that was not.

### The idea

Make `sessionOverhead()` hold what the provider actually receives, so
`ContextCompressor#isOverBudget` decides with the real floor instead of the
prompt Umbra happened to build.

### What is actually missing

`recordSessionOverhead` runs at construction, before deepagents concatenates
its own prompt blocks. On `gemini-2.5-flash-lite` the guard holds 3,307 tokens
against a measured floor of 4,880: **1,573 unseen, 32.2% of the floor**. Before
`write_todos` was compacted the gap was 54%.

The obvious fix is wrong in the other direction. Recording from a
`wrapModelCall` hook reads the system prompt correctly — nothing after Umbra's
hooks adds text — but every Umbra hook runs **before** deepagents'
`_ToolExclusionMiddleware`, which is pushed last. The tool list a hook sees is
the pre-exclusion list, seven builtins (`ls`, `read_file`, `write_file`,
`edit_file`, `glob`, `grep`, `task`) larger than what is sent. It would replace
a known under-count with an over-count that looks authoritative.

### The mechanism to reuse

- The system half: `request.systemMessage` in any Umbra `wrapModelCall`, which
  `createCompactTodoToolMiddleware` already runs first in all four root agents.
- The tool half: the exclusions each harness profile registers.
  `registerGeminiHarnessProfile`, `registerAnthropicHarnessProfile` and the
  Ollama branch of `DeepAgentFactory#bootstrap` compute those lists and discard
  them. Returning them is the missing piece.
- The check: `npm run bench:floor` already reports `measured` against
  `believed`. A fix is done when `unseen` is near zero on every provider, not
  when a unit test passes.

### Plan

1. Return the excluded tool names from each harness-profile registration.
2. Record overhead from the first model call: system from `request.systemMessage`,
   tools from `request.tools` minus the registered exclusions.
3. Run `npm run bench:floor` per provider and require `unseen` within a stated
   tolerance before calling it closed; commit the reports.


> **Amendment — 2026-09-23, after the LangChain upgrade.** The numbers above are
> deepagents 1.10.2. On 1.14 the deep agent's floor is 3,827 and the guard sees
> 3,299 of it: **528 unseen, 13.8%**. The orchestrator is at 12.4% and the MCP
> advisor at 0.8%. The gap shrank for a reason unrelated to closing it: 1.14
> concatenates less into the system prompt.
>
> What is left is almost exactly the todo list — the compact `write_todos` and
> its system block — and that changes the plan. Umbra now installs
> `todoListMiddleware` itself in `DeepAgentFactory`, so it knows that cost at
> construction. Adding the tool and its prompt block to what
> `recordSessionOverhead` records closes most of the remaining gap without the
> pre-exclusion problem above, which only ever applied to tools deepagents adds.
> The exclusion-list route stays the fix for whatever deepagents contributes
> next.

> **Amendment — 2026-09-23, superseded.** The guard this entry is about no
> longer exists. ADR-037 replaced `ContextCompressor.isOverBudget` with
> context editing, which counts the real request inside the model call, and
> `isOverBudget` and `estimateTokens` were removed with their only caller. So the
> plan above is moot. What is left is smaller: `recordSessionOverhead` still
> records into a registry nothing in production reads, and `bench:floor` still
> reports it as "what the budget guard sees" — a guard that is gone. Retire the
> registry and the three `recordSessionOverhead` calls in `DeepAgentFactory`, and
> relabel or drop the bench's "believed" figure in the same change.
>
> Adjacent, and found at the same time: `ContextCompressor.compress`, which
> `/model` still uses to hand a summary to a new agent, has never had a test.

---

## A CLI ignore pattern replaces the config's, and the suite runs twice

> Deferred 2026-09-23. Found while verifying the same change: a unit run
> reported 225 suites instead of 112.

### The idea

Make `npm run test:unit` exclude what `jest.config.ts` excludes, so a run with a
git worktree present counts this checkout's suites once.

### What is actually missing

`test:unit` passes `--testPathIgnorePatterns=integration|e2e|contract`. On the
CLI that flag **replaces** the config's `testPathIgnorePatterns` rather than
adding to it, which silently drops `/node_modules/`, `/dist/` and `/\.claude/`.
With a worktree under `.claude/worktrees/` — which every parallel Claude session
creates — the unit run executes that checkout's specs too. The config's own
comment describes exactly this symptom; the script reintroduces it.

### The mechanism to reuse

The three config patterns, restated inside the CLI value, restore them. The
unescaped pipe in that value is also why the script breaks on Windows, so both
defects are fixed by the same edit.

### Plan

1. Move the category split out of the CLI flag — for example a `projects` or a
   dedicated config for unit runs — so no script has to restate the ignores.
2. Assert the suite count in CI, so a doubling is a failure rather than a
   surprise.

---

## `request.systemPrompt` is deprecated, and two middlewares still write it

> Deferred 2026-09-23. Found while verifying the LangChain upgrade.

### The idea

Move the two Umbra middlewares that read or write the system prompt from
`request.systemPrompt` to `request.systemMessage`.

### What is actually missing

`subagent-budget.middleware.ts` appends its exhausted-budget instruction by
setting `request.systemPrompt`, and `iteration-budget.middleware.ts` reads it
to count the prompt. The field is `@deprecated` in langchain. It works today:
`AgentNode` in langchain 1.5.12 detects a changed `systemPrompt` and builds a
new `SystemMessage` from it, so the instruction still reaches the model —
verified in the installed source.

The day the field is removed, the instruction stops reaching the model with no
error, because setting an unknown property on a request object is silent. That
is the same shape as every defect this upgrade surfaced: correct types, wrong
runtime.

### The mechanism to reuse

`request.systemMessage` is the field `AgentNode` treats as authoritative, and
langchain 1.5.12 already refuses a request that changes both — so the migration
must replace the `systemPrompt` write, never add a `systemMessage` one beside
it.

### Plan

1. Rewrite both middlewares against `systemMessage`.
2. Add a real-`createAgent` spec, in the style of
   `compact-todo-tool.middleware.spec.ts`, asserting the exhausted instruction
   is in what the model is bound with — which no current test checks.
