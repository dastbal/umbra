# ADR-031 — Measure before building, and freeze what is not on the path

| | |
|---|---|
| **Category** | Quality · Evaluation · Roadmap · Cost |
| **Author** | David Balladares (decision) · Claude (record) |
| **Date** | 2026-09-08 |
| **Status** | ✅ **Accepted** — all three phases implemented and measured; two phase-2 items deliberately deferred |
| **Refines** | ADR-019, ADR-024, ADR-028 |

---

## Context

An external review of this repository produced three criticisms. Checked
against the code, **two of them were wrong**, and recording why matters as much
as recording the plan — the wrong ones would have sent three months of work at
problems that are already solved.

**"Cosine similarity is mixed across providers, justified by a dimension
coincidence."** Not true here, and defended in three independent places.
`chunk_vectors` has the primary key `(chunk_id, provider, model)` (ADR-026);
both `RetrieverService#rankInSql` and `RetrieverService#rankInJavaScript`
filter `WHERE v.provider = ? AND v.model = ?`; and `cosineSimilarity` in
`src/core/rag/math.ts` throws on a length mismatch — a guard, not a
justification. `RetrieverService#query` raises `EmbeddingsIndexMismatchError`
when a model changes its output shape inside one provider, which is the harder
version of the same failure. The review described a defect this repository had
already closed deliberately.

**"There is no token counting before the call."** Also not accurate as stated.
`ContextCompressor.estimateTokens` is a pre-call estimate, and
`ChatSession#checkAndCompressContext` uses `ContextCompressor.isOverBudget` to
fire compression proactively at 80,000 estimated tokens.

**The third was right, and the first two being wrong made the real gap
sharper.** The genuine problems are narrower and worse than the ones reported:

1. **The abstention trade-off ADR-028 accepted has never been measurable.** The
   record states plainly that conceptual questions with only a semantic
   neighbour now abstain, and that this "must be measured before release". It
   shipped unmeasured — not through neglect, but because the corpus made it
   structurally impossible. All **ten** negative cases in
   `docs/benchmarks/embedding-retrieval-corpus.json` sat in the `holdout`
   split; `calibration` held 45 positives and zero negatives. Measuring the
   abstention policy therefore required burning the holdout, so it was never
   measured at all.

2. **The scoring fused failures that are fixed by opposite changes.** The audit
   runner reduced every case to one `hitAt4` average, in which a positive that
   returned four wrong files and a positive that returned nothing are both
   `hit: 0`. The first is a ranking defect; the second is the evidence policy
   being too strict. It also read each case's `split` field and never
   aggregated by it, folding the holdout into the headline number.

3. **The results could not be committed.** The runner defaulted its output to
   `.umbra/audits/embedding-benchmark-<Date.now()>.json`, and `.umbra/` is in
   `.gitignore`. Every measurement this project has ever taken was written to a
   path that cannot enter the repository. The one surviving number — 30% Hit@4,
   in ADR-027 and ADR-028 — exists only as prose, which proves a measurement
   happened once and can never show whether a change helped.

4. **`estimateTokens` does not count the prompt.** It sums `msg.content` and
   nothing else: not tool-call arguments, not the system prompt, not the tool
   schemas, which for a deep agent are thousands of fixed tokens on every
   request. The number compared against the 80,000 threshold is a subset of the
   visible history, and `chars / 4` is a heuristic rather than a tokenizer.
   Meanwhile `safe_read_file` in `src/core/tools/file-tools.ts` returns whole
   files with no ceiling, which is the actual mechanism by which a turn
   explodes.

5. **`chat-session.ts` is 1,418 lines** while the domain and RAG layers stayed
   small — the ordinary shape of a project where one layer gets attention and
   the other merely has to work.

CI (`.github/workflows/test.yml`) runs type-check, jest and build. No retrieval
quality gate exists at any point in the pipeline.

## Decision

**Work is ordered by what can be measured, and anything off that path is frozen
rather than allowed to grow.** These are one decision, not two: a freeze is how
"not now" stops being a wish. Without it the deferred work grows while the
measured work proceeds, and the deferral quietly becomes permanent.

### Phase 1 — Retrieval evaluation becomes a first-class artifact *(implemented)*

1. **Calibration gets its own negatives.** Ten new negative cases join
   `calibration` in `docs/benchmarks/embedding-retrieval-corpus.json`
   (corpus version 4 when written, **v5 today**; 70 cases). They are deliberately **different subjects**
   from the holdout negatives — Prometheus, GraphQL, Kafka, Terraform and so on
   rather than the holdout's Redis, Kubernetes and Stripe — because reusing a
   subject leaks the holdout through the calibration set. Each term was
   verified absent from `src/` before being added.

2. **Scoring moves into `src/core/rag/retrieval-metrics.ts`, under test.** The
   scoring rule is the one part of an evaluation that must not drift silently,
   because a number that moved for metric reasons reads exactly like progress.
   `scoreCase` reports `falseAbstention` and `falsePositive` as fields distinct
   from `hit`; `summarizeSplit` computes `hitRate` and `mrr` over positives
   only, and returns **`null` rather than `0`** for a rate with an empty
   denominator — `correctAbstentionRate: null` says the policy was not tested,
   which is a different claim from failing every case, and conflating the two
   is what hid this gap. `summarizeRun` reports per split with `all` last.

3. **The runner lives in the repository**, at `scripts/bench-retrieval.mjs`,
   behind `npm run bench:retrieval`. It keeps the compiled MCP binary as the
   integration boundary (ADR-028), adds `waitForIndex` so a warm-up window
   cannot be recorded as a quality regression, and reports the tool's own error
   text instead of a bare corpus id.

4. **The holdout needs a flag.** `--split holdout` and `--split all` refuse to
   run without `--allow-holdout`. This is friction, not security, placed where
   the mistake is easy and invisible.

5. **Reports are committed**, to `docs/benchmarks/results/`, named by date,
   providers and split — **and, since the 2026-09-09 amendment, by commit**,
   because naming without it let one run overwrite another and left two
   incomparable reports side by side. `docs/benchmarks/results/README.md`
   states how to read one and why the `all` row is never the headline.

### Phase 2 — Counting the prompt before paying for it *(implemented, except routing and early rejection — see the 2026-09-08 amendment)*

A `TokenCounterPort` in the domain with per-provider adapters — Anthropic's
`count_tokens` endpoint, Gemini's `countTokens`, a local tokenizer for Ollama —
resolved and pinned the way ADR-025 resolves an embedding identity, never
inferred from a model string. It must count the **whole request**: system
prompt, tool schemas, history, and tool-call arguments. The fixed part is
counted once per session and only the delta per turn.

It unlocks four things that are impossible with a post-hoc count, and only the
first exists in any form today:

- a compression threshold that is a real share of the context window;
- a ceiling applied to `safe_read_file` output **before** injection;
- routing by size, so an oversized prompt goes to the cloud model rather than
  the local one;
- rejecting a prompt that exceeds the window without paying for the round trip.

LangSmith and `TurnGovernor` are unaffected: they answer what a turn cost, and
this answers what a turn will cost. The open question this phase must also
settle is whether the embedding adapters emit any trace at all — they implement
Umbra's own `embeddings.port.ts` rather than LangChain's `Embeddings`, so a
large `umbra index` is likely invisible to LangSmith.

### Phase 3 — `query_dependency_graph` over NestJS modules *(implemented as `query_nest_graph` — see the 2026-09-09 amendments)*

The MCP surface is where Umbra is infrastructure for someone else's agent
rather than a competitor to it, and a dependency graph that understands
modules, providers and injection is what generic tooling does badly. It draws
on the RAG layer, which is the best-built part of the repository, and needs
nothing from the CLI. It comes third because building it before phase 1 means
shipping it with no way to show it beats `grep`.

### The freeze

`src/presentation/cli/module-size-ceiling.spec.ts` fails if
`chat-session.ts` exceeds 1,418 lines — its size on the day of this record.
Existing size is grandfathered; new size is not. A second assertion fails once
the file drops 50 lines below its ceiling without the ceiling being lowered in
the same commit, so a reduction cannot be spent on later growth.

This is explicitly **not** a refactor. Splitting a 1,418-line session
controller is a large change with thin test coverage, competing for attention
with the measurement work above. Stopping the growth costs one spec file.

## Trade-offs actually considered

| Option | Pros | Cons | Decision |
|---|---|---|---|
| **Study embeddings first** (the review's recommendation) | Closes a knowledge gap; the reviewer's diagnosis of *why* the gap exists is fair | Aimed at a defect ADR-025/026 already made unrepresentable. Would produce reading, not a number | ❌ Rejected on evidence |
| **Evaluation first** | The harness mostly existed; the ADR-028 debt is live and unmeasured; every later phase gets a number instead of a belief | Least visible progress — no feature ships | ✅ **Chosen** |
| **Token counting first** | Self-contained; unlocks real cost control | Nothing tells you whether the compression it triggers helps or hurts retrieval quality. Needs phase 1 to be judged | ⏭ Second |
| **Refactor `chat-session.ts` now** | Removes the most visible ugliness | Large, risky, thinly covered, and fixes the layer that is not the bottleneck. The tempting work rather than the useful work | ❌ Deferred, with a ceiling instead |
| **Raise the ceiling when needed** | No friction | A ceiling that moves is a comment | ❌ Rejected |

## Consequences

### Positive

- The ADR-028 abstention trade-off becomes measurable without touching the
  holdout, for the first time since it was accepted.
- A false abstention and a wrong ranking are now distinguishable, so a result
  points at which lever to pull.
- Retrieval quality acquires a committed history instead of a remembered number.
- The holdout is protected by a flag rather than by intent.
- `chat-session.ts` cannot get worse while the work above happens.

### Neutral

- Corpus version 4 supersedes version 3. Reports produced against version 3 are
  not comparable case-for-case; the `corpusVersion` field in every report says
  which was used.

### Negative

- `retrieval-metrics.ts` is compiled into `dist/` and therefore ships to
  consumers, who will never call it. The alternative — scoring beside the
  script — puts the rule outside `type-check` and outside jest, which is the
  failure mode this decision exists to prevent. A few kilobytes is the cheaper
  side of that trade.
- The benchmark still requires a local Ollama or Vertex credentials, so it
  cannot run in CI as written. A fixture index with pre-computed vectors would
  make the ranking and abstention policy testable offline and deterministically;
  it is the remaining phase 1 step and is **not** implemented by this record.
- Two runner implementations now exist. `scripts/bench-retrieval.mjs` is
  canonical for metrics; the copy in
  `.agents/skills/umbra-embedding-retrieval-audit/scripts/run-benchmark.mjs`
  keeps its provider-authorization preflight and is left untouched rather than
  deleted. That divergence is real and should be closed by making the skill
  script delegate to this one.
- Phases 2 and 3 are recorded here as ordering only. Neither is built, and this
  record must not be read as evidence that either works.

## Verification Evidence

**The corpus gap is real, and now closed.** Before, counted directly from the
file:

```
calibration/positive: 45   calibration/negative: 0
holdout/positive:      5   holdout/negative:    10
```

After, at corpus version 4: `calibration/negative: 10`, 70 cases, 70 unique ids.

**The metrics module.** `npx jest src/core/rag/retrieval-metrics.spec.ts` →
`10 passed, 10 total`. The suite asserts the distinctions the previous scoring
could not express: a wrong path versus an abstention on the same positive case,
`null` versus `0` for an untested rate, and calibration reported apart from
holdout.

**The ceiling.** `npx jest src/presentation/cli/module-size-ceiling.spec.ts` →
`2 passed`. `chat-session.ts` is 1,418 lines by `wc -l`.

**Nothing else moved.** `npm run type-check` clean; the full suite
`813 passed, 5 skipped, 93 of 94 suites`.

**The readiness gate was written against an observed failure, not a predicted
one.** The first live run of the runner failed on the first case with
`Semantic search is not ready: Checking the configured embedding provider.`
A direct `get_index_status` probe against the compiled binary showed why:

```
state:           skipped
chunks:          999
missing vectors: 0
stamp:           missing, partial, or mismatch
```

Vectors were complete and the stamp was stale, because this session added
source files. Without the gate the runner would have crashed on a warm index
or, worse, recorded a run of zeros as a quality regression.

A second live run produced the other failure the gate now handles. With the
jest suite competing for the machine, `get_index_status` reported
`state: unavailable — Ollama is not reachable at http://localhost:11434` while
`curl` against `127.0.0.1:11434` answered immediately. Measured from Node,
`localhost` takes 887 ms against 154 ms for `127.0.0.1` — Windows resolves
`::1` first and Ollama binds IPv4 only. The gate now fails fast on a second
consecutive `unavailable` instead of waiting fifteen minutes. Changing the
default base URL is a separate matter and is **not** done here.

**The old runner's output path is gitignored.** `.umbra/` is listed in
`.gitignore`, and the previous default output was `.umbra/audits/`.
`git check-ignore` confirms the new paths are not ignored.

### Not verified

- No Vertex run. This record authorises no provider call; a paired comparison
  needs explicit approval for its exact query count, as ADR-027 established.
- The holdout was not read.
- No claim is made about phase 2 or phase 3 behaviour.

## Related Files

- `docs/benchmarks/embedding-retrieval-corpus.json` — corpus v4, calibration negatives
- `docs/benchmarks/results/README.md` — how to read a report, and why `all` is not the headline
- `src/core/rag/retrieval-metrics.ts` — `scoreCase`, `summarizeSplit`, `summarizeRun`
- `src/core/rag/retrieval-metrics.spec.ts` — the assertions that pin the scoring rule
- `scripts/bench-retrieval.mjs` — `waitForIndex`, `runProvider`, `provesActiveProvider`
- `src/presentation/cli/module-size-ceiling.spec.ts` — `CEILINGS`, `SLACK`, `lineCountOf`
- `package.json` — `bench:retrieval`
- `src/core/agent/context-compressor.ts` — `estimateTokens`, `isOverBudget` — what phase 2 replaces
- `src/core/tools/file-tools.ts` — `safe_read_file`, unbounded until phase 2
- `src/presentation/cli/chat-session.ts` — `ChatSession#checkAndCompressContext`, the frozen file
- `src/core/rag/retriever.ts` — `RetrieverService#query`, `#rankInSql`, `#rankInJavaScript` — the subject of the measurement
- `src/core/rag/math.ts` — `cosineSimilarity`, the dimension guard the review misread
- `docs/adr/ADR-028-hybrid-retrieval-requires-evidence.md` — the unmeasured trade-off
- `.agents/skills/umbra-embedding-retrieval-audit/scripts/run-benchmark.mjs` — the superseded runner, kept for its preflight

---

## Amendment — 2026-09-08 · Phase 1 produced its first number, and it changed two beliefs

The measurement this record was written to make possible has been taken. It
required repairing the index first, which is itself part of the finding.

**Two index defects had to be fixed before any number meant anything.**

`IGNORED_DIRECTORIES` in `WorkspaceDiscoveryService` did not list `.claude`,
and `.claude/worktrees/<name>/` is a complete second checkout of this
repository — 241 TypeScript files. Discovery walked it, so the index held the
repository twice: `file_registry` carried 309 rows for 157 files, and
`code_chunks` held 1,005 rows of which 439 were the duplicate set. The same
hole existed in `jest.config.ts`, where the suite was silently running twice —
183 suites and 1,633 tests instead of 97 and 818.

Separately, 206 registry rows claimed `index_state = 'indexed'` with **zero
chunks**: files the chunker skipped before `fix(rag): index classless source
modules`, which `FileRegistry#isFileChanged` can never revisit because it
compares only the stored hash. The current chunker was verified correct by
calling `NestChunker#analyze` directly — one `file` chunk each for `math.ts`,
`hybrid-ranking.ts`, `embeddings-resolver.ts`, `vector-codec.ts` and
`turn-governor.ts`. The defect is the missing repair path, not the chunker, and
it is not fixed here.

The consequence for the historical number: **24 of the 43 distinct expected
paths in the corpus had no chunk at all.** The reachable hit ceiling was ~44%,
so the 30% Hit@4 recorded in ADR-027 and ADR-028 was never a measurement of
retrieval quality. It measured index coverage.

**The number, on a clean index.** 55 calibration cases, Ollama
`nomic-embed-text`, through the compiled MCP binary, coverage 43/43 so the
ceiling is 100%:

| | |
|---|---|
| Hit@4 (45 positives) | **88.9%** |
| MRR | 0.706 |
| False abstention | **0%** |
| Correct abstention (10 negatives) | **0%** |
| p95 latency | 827 ms |

Ranking is strong. The abstention policy is broken in the direction nobody
was watching — see the 2026-09-08 amendment to
[ADR-028](./ADR-028-hybrid-retrieval-requires-evidence.md). Both facts were
invisible until the split-aware, coverage-checked harness existed, and the
second one was structurally unmeasurable while every negative case lived in the
holdout.

This is the argument of this record, demonstrated on the day it was written: the
belief that was defended in prose (abstention is too strict) was false, and the
defect nobody suspected (abstention never fires) was sitting in production.

### Phase 2, first slice — implemented

`TokenCounterPort` with `LocalTokenCounter`, `requestTextOf`, and a ceiling on
`safe_read_file`. `ContextCompressor.estimateTokens` now counts the whole
request rather than `msg.content`: tool-call arguments, per-message framing,
and — when a caller supplies them — the system prompt and tool schemas.

Not yet done in phase 2: no call site passes `overhead` yet, so the compressor
still under-counts by the fixed cost of the tool catalog; and routing by size
and early rejection are not implemented.

### Still not verified

- No Vertex run. No paired comparison.
- The holdout has not been read.
- The abstention correction is described, not built.

---

## Amendment — 2026-09-09 · Phase 3 is implemented, and this repository could barely test it

`query_nest_graph` is published. `analyzeNestGraph` reads the wiring,
`nest_bindings` / `nest_injections` / `nest_scan` store it, and the tool answers
three questions: which module binds a token, which classes inject it, and what
one module binds.

### What the repository turned out to be

Phase 3 was written on the assumption that a NestJS module graph is what this
repository has most of. It is not. Three files mention `@Module(`, five carry
`@Injectable`, and the root module's decorator is literally `@Module({})`.

That last fact stopped the work for an hour and is the most useful thing this
phase found. The first probe of `@Module({ ... })` returned an object literal
with **zero properties** and looked like a parser bug. It was not: both of this
repository's modules are **dynamic modules**, whose real wiring lives in a
`forRoot()` return value. So does every configurable NestJS module in existence
— every `forRoot`, `forRootAsync`, `register`. A tool that reads only the
decorator reports "no providers" for exactly the modules that matter most, and
reports it confidently.

A generic tool getting that wrong is the argument for this phase, stated more
precisely than the original record managed: the value is not "a dependency graph
for NestJS", it is *understanding the shapes NestJS actually ships in*.

### Two defects found by running it, not by testing it

**Injections were recorded for every class with a constructor.** The unit tests
passed; the first live run over this repository recorded `IndexerService` — an
ordinary class — as needing `EmbeddingsPort` and `(progress: string) => void`.
The second is not a token at all. Nest injects only into `@Injectable` and
`@Controller` classes, and the extractor now says so.

**The graph would have shipped empty.** `FileRegistry#isFileChanged` compares
content hashes, so an already-indexed repository re-runs the indexer and
processes nothing: the new tables would have stayed empty forever while the tool
answered "no modules". This is the third appearance today of one defect shape —
derived data with no path back for an index that already exists. `nest_scan`
records the registry's own hash so the backfill has one definition of "changed",
and reading costs no embedding call.

### Verified through the compiled binary

Six tools published, and the answers below are live output, not fixtures:

```
provides(AI_AGENT)
  AiAgentModule exports it — only when registered dynamically
  AiAgentModule provides it (factory) — only when registered dynamically
injects(AI_AGENT)
  AiAgentHttpService (@Inject)  src/presentation/http/ai-agent-http.module.ts
module(AiAgentHttpModule)
  controllers: AiAgentHttpController [dynamic]
  providers: AGENT_HTTP_OPTIONS (value) [dynamic], AiAgentHttpService [dynamic]
```

`AGENT_HTTP_OPTIONS` is a string constant. It belongs to no file, so no
file-import graph — and no `grep` for an import — can say where it comes from.
That single row is the whole argument for the feature.

### Honest limits

- **This repository cannot validate the feature at scale.** Two modules is not
  a monorepo. The unit tests cover the shapes; nothing here covers a hundred
  modules, `forwardRef` cycles, or re-exported modules.
- **No cross-file token resolution.** `findUnexportedInjections` reports a
  suspicion, never a verdict: Nest resolves a provider without an export inside
  one module, so presenting its output as a defect list would overstate it.
- **The retrieval corpus does not cover it.** Every measurement in this record
  is about `ask_codebase`. `query_nest_graph` has tests and a live check, and
  **no benchmark** — which is precisely the gap this ADR exists to complain
  about. A wiring corpus is the obvious next measurement.
- One full-suite run failed once, immediately after a live `umbra index`, and
  did not reproduce across four subsequent runs. Recorded rather than dismissed.

---

## Amendment — 2026-09-09 · The gap this record complained about, closed on itself

Two measurement defects and one missing measurement, all found by reading the
work back rather than by running it.

### A report without its commit is an anecdote with a schema

The first two committed reports were named by date, providers and split alone.
Within a day that produced both failures it could: a second run overwrote the
first, and the two that survived were taken at **different commits** — one
before the abstention fix and one after — while sitting side by side in a
directory whose entire purpose is comparison.

Reports now carry `commit` and `dirtyWorkingTree`, and the filename carries them
too. A dirty tree is recorded rather than refused: benchmarking mid-change is
often the point, it just must not later be read as a run of the commit it sits
on. The two earlier reports were renamed and carry a `provenanceNote`.

`docs/benchmarks/results/README.md` now lists the four things to check, in
order, before believing any difference: same corpus version, same reachable
ceiling, same provable negatives, and only then the retriever.

### A negative case rots, and it rotted twice

`assessNegativeHealth` is the mirror of the coverage preflight. Coverage stops a
hit rate being read when the index cannot answer the positives; this stops an
abstention rate being read when the negatives have stopped asking anything.

It proved itself on its first run, at this record's expense. The run reported
one rotted negative, and the cause was the TSDoc written **inside the very
function built to detect this**, which named the term again. Correct abstention
had already slipped 100% → 90% for that reason alone, and nothing else would
have explained it. Removing the word restored 10/10.

A case that is hard on purpose — a subject this repository mentions but does not
implement — is marked `unprovableByAbsence` in corpus v5, so the check
distinguishes a hard case from rot instead of crying wolf every run.

### Measured at 9f7d0bc

| | |
|---|---|
| Hit@4 | 84.4% |
| MRR | 0.689 |
| False abstention | 2.2% |
| Correct abstention | 100% |
| Coverage | 43/43, ceiling 100% |
| Negatives provable | 10/10 |

Hit@4 moved 86.7% → 84.4% against the previous day: 38 of 45 rather than 39.
Inspecting the cases shows one abstention and six ranking misses to close
neighbours, and the index gained about twelve source files that day, so the
competition changed. **Nothing in the retriever moved.** That explanation exists
only because the report now records which commit and which coverage it was taken
under — which is the argument for the change, demonstrated by the first number
it produced.

### `query_nest_graph` is measured too, by a different kind of suite

Phase 3 shipped with no measurement, which this record called out as its own
gap. It is closed, but not with a benchmark: the tool answers from SQL rather
than from ranking, so there is no hit rate to compute. Its failure mode is
worse than a bad rank — given a shape it does not understand it reports
**nothing**, and "this module has no providers" is indistinguishable from "this
module was not understood".

`docs/benchmarks/nest-wiring-shapes.json` holds thirteen shapes NestJS is
actually written in — `forRoot`, `forRootAsync` with a factory and an inject
array, `forFeature` as a call expression, `@Global`, `forwardRef`, a re-exported
module, a spread provider list, `@Optional() @Inject()`, and a plain class that
must **not** be read as an injection site. Eleven are read; two are declared
limitations (a provider array lifted into a `const`, and the contents of a
spread). The suite fails if any shape that expects bindings produces none, so
the silent failure becomes loud.

The dynamic-module shape is in there because it was caught by accident. Had
this repository happened to use static modules, phase 3 would have shipped blind
to the shape that covers every configurable module in the ecosystem.

---

## Amendment — 2026-09-09 · The three deferred items are closed

David approved all four open items. The fourth — the repair path for files
recorded as indexed with zero chunks — is being done in a separate session and
is not this record's to claim. The other three are below.

### Early rejection, and the table that unblocked it

The counting shipped days before this; what was missing was anything to compare
it against. No per-model context window existed anywhere in the codebase, so a
count of 240,000 tokens was a number nothing could act on.

`DEFAULT_CONTEXT_WINDOWS` inherits `DEFAULT_LLM_PRICING`'s hard-won rule: a
missing entry there once read as a cost of **zero** rather than as an absence.
A missing window must never read as *unlimited* — the same defect pointing the
other way, and worse, because it turns the guard into a rubber stamp exactly
when the request is enormous. `contextWindowFor` returns `undefined` and the
check abstains.

Gemini and Ollama are absent on purpose. The table holds only sourced figures;
filling Gemini's from memory would produce something that looks complete and
errs in the direction that hurts. Ollama cannot be tabulated at all — its window
is the local install's `num_ctx`, not a property of the model name.

The check runs in `wrapModelCall`, the only seam that sees the whole request
before it is sent. Without it the provider answers the same question by charging
for the trip and returning an error that names no cause, which ADR-007's
self-healing then treats as a session to reset — so the operator sees a restart
and no reason.

### Routing, which is an ADR-002 amendment rather than a feature

Recorded in full at [ADR-002](./ADR-002-model-routing-and-bounded-analysis.md).
The rule David chose: **only a model nobody chose may be routed away from.**
`--model` and `AGENT_MODEL` are decisions a person made, and arithmetic does not
override a decision; the project default is not a decision, and may be routed —
announced, never silently, to the cheapest model that fits rather than the
largest.

### The CI gate, and what it is not

`bench-retrieval` cannot run in GitHub Actions, which is why every quality
number in this record was a local observation. The gate scores ranking, rank
fusion and abstention against a committed fixture: 158 chunks, their vectors,
one frozen vector per case, 15 positives and **all ten** negatives — the
abstention policy is what broke, and a subset without them would score only the
half that was never in doubt.

ADR-028 holds that the compiled binary is the integration boundary, and it still
does for what it was written about: launch pinning, the published schema, the
read-only contract. A *quality* gate needs none of those, so this one runs below
the transport and leaves the binary check to the live benchmark.

Building it found a defect in the first attempt. `RetrieverService` embeds the
**expanded** query — it runs the request through retrieval memory first — so the
fixture had frozen vectors of a string production never sends. Builder and gate
now derive the same form through the same function.

```
retrieval gate — hit 0.867 · false abstention 0.133 · correct abstention 1.000
```

**That false-abstention figure is not the live one and must not be quoted as
such.** The fixture holds 158 chunks against the repository's ~1,000, and the
unknown-term rule asks whether a query's terms appear anywhere in the index — a
smaller index makes more terms unknown and the rule stricter. 0.133 here, 0.022
live; both correct about different things. The gate is a regression detector
against its own baseline. The live benchmark remains the measurement of quality.

It also does not see the embedding model at all: the vectors are frozen, so
swapping `nomic-embed-text` for something better would not move a number here.

### Still open

- The repair path for chunkless files, in another session.
- `query_nest_graph` has a shape-coverage suite and no live measurement at
  scale; this repository's two modules cannot provide one.
- The gate's floors were set from a single run. They should be revisited once a
  few runs establish the real variance, which is the same discipline the
  deferred-work entry asked for and this record has not yet earned.

## Amendment — 2026-09-10 · A second external review, what the vectors buy, and the ceiling this gate does not have

### Twice is a pattern about the path, not about the reviewers

This record's context notes that *two of three external review findings did not
hold against the code*. It happened again, at the same ratio: an audit of the
published 2.2.5 package produced three findings, and two were decisions already
recorded and measured — the unknown-term abstention (ADR-028's amendment, with
its trade priced) and the test-file exclusion (ADR-030's discovery scope).

The common cause is worth naming, because it is fixable and it is not the
reviewers' diligence. Both reviews read the **code** first and reached the
**records** afterwards, and the code cannot state why it is the way it is. This
project publishes the tool that makes the cheap order possible — `list_adrs`,
which ADR-004 exists to provide precisely so decision history is consulted
without reading every record. The second audit used it against a consumer
repository and never pointed it at this one.

So the finding is procedural: an audit of Umbra should open
`docs/adr/README.md` and match its `Tags` column before it opens `src/`. The
index says so in its own first paragraph. Recorded here rather than in a skill,
because the next review may not run through a skill.

What survived the second review was better than what it claimed, and is recorded
in `docs/reports/2026-09-10-retrieval-cost-and-latency.md`.

### Phase 1's artifact answered a question phase 1 never posed

The corpus, the metrics under test and the committed report series were built to
tell whether a retrieval change helped. They turned out to answer something
larger for free: **what the embedding apparatus buys.** The audit had proposed
removing it, and until this run nothing in the repository could price it.

`scripts/bench-fts-only.mjs` scores the same corpus with the semantic branch
removed. Calibration at `e72d7a8`, 169 files, 1,022 chunks, both arms under a
100% reachable ceiling with 10 of 10 negatives provable:

| Arm | hit@4 | mrr |
| --- | --- | --- |
| hybrid | 0.867 | 0.683 |
| fts-only | 0.667 | 0.585 |

Twenty points. The shape matters more than the size: of the nine positives only
the vectors rescue, **eight were answered by the lexical arm** — it returned
files, confidently, and they were wrong. The vectors are not buying recall, they
are buying the difference between a confident wrong answer and a right one. And
in 45 positives there was no case where fusion displaced a correct lexical hit.

Two arms are reported because removing the vectors changes two things at once:
with no semantic ranking the `hybrid` evidence class is unreachable, so
`hasGroundedEvidence` can only ground on `lexicalExact` and abstention tightens by
omission. That side effect is 2.2 points of the 20; the other 17.8 are ranking.
Reporting only the shipped policy would have credited the vectors for an artefact
of the abstention rule — the same conflation this record was written about.

**The embedding apparatus is justified by evidence and stays.** The proposal to
remove it is closed, and so are two candidates that were waiting on this number.

### The scan was never the latency lever

ADR-026 records the remaining linear scan as an accepted negative, and
`docs/deferred-work.md` holds `vec0` indexed KNN against a real measurement.
That measurement now exists, and it points somewhere else. Timed in isolation
against the same index:

| Stage | Median |
| --- | --- |
| the readiness gate, `inspectIndexIntegrity` | 202.4 ms |
| the query embedding, warm | 87.2 ms |
| FTS, vector ranking and fusion — the search | 2.2–5.6 ms |

The three sum to ~295 ms against a 293.6 ms observed median, so they account for
the whole round trip. The search is about one percent of it. `readReadiness`
calls `inspectIndexIntegrity` on **every** `ask_codebase` call, which opens a
second SQLite connection, re-runs workspace discovery and md5-hashes every
discovered source file — to re-derive what `.umbra/index.identity.json` already
records. The graph tools do not pass through that gate, which is the entire
explanation for the latency gap the audit observed between them and
`ask_codebase` and attributed to the embedding call.

Consequence for the roadmap: making the readiness gate cheap is worth more than
indexed KNN by a wide margin, and neither is worth anything until it is measured
on a repository large enough for the scan to matter.

### The gate has floors and no ceiling

`retrieval-gate.spec.ts` asserts a hit floor, a false-abstention cap and a
correct-abstention floor. Nothing asserts anything about the **size** of an
answer, and nothing anywhere does: there is no max-tokens, max-files or
truncation bound on any MCP tool response. `read_file` has
`DEFAULT_MAX_READ_TOKENS` at 6,000 with an env override; `ask_codebase` has
nothing, and its output is whatever four files' skeletons and chunk bodies happen
to be.

That is why the skeleton block growing was something an audit found rather than
something the build reported. The follow-up metric is response cost, and by this
record's own rule it belongs beside `retrieval-metrics.ts` under test rather than
in a script, so it cannot drift silently. A ceiling calibrated against one
repository would repeat the mistake ADR-028 named, so it needs at least two.

### Still not verified

- No single real request was traced end to end; the latency split is three
  isolated measurements that happen to sum to the observed median.
- The consumer-repository figures quoted in the report — the bimodal token
  distribution, the 65% peak skeleton share, the 13–16 s boot, the sub-250 ms
  readiness race — come from audit sessions whose raw captures did not survive.
  They are prior observations, not reproducible measurements. The committed
  harness is what makes the next round reproducible.

---

## Amendment — 2026-09-23 · The floor, measured where it leaves the process

Phase 2 is *counting the prompt before paying for it*. What it counted was the
prompt Umbra builds, recorded at construction by `recordSessionOverhead` in
`src/core/agent/session-overhead.ts`. What the provider receives is larger:
deepagents concatenates its own prompt blocks after construction, and its todo
middleware contributes a tool Umbra never declares. Nothing had measured the
difference, because nothing measured at the boundary.

### How it was measured, and why the model class could not be faked

`scripts/bench-turn-floor.mjs` (`npm run bench:floor`) builds the real agent
through `DeepAgentFactory#create` and replaces only the provider model's
`_generate`, so what it records is by construction what would have been sent.
The provider model is the real class on purpose: deepagents resolves an
instance to a harness profile by class name (`getModelProvider`), so a fake
model would have been measured under a different profile and reported a
different catalog. The class is an input to the measurement.

### What it found

On the default configuration (`gemini-2.5-flash-lite`, `cl100k_base`), before
this amendment's change:

| | Tokens |
|---|---|
| Measured at the boundary | 7,239 (system 3,904 + 12 tools 3,335) |
| What `sessionOverhead()` holds — the number `ContextCompressor` decides with | 3,307 |
| **Unseen by the guard** | **3,932 — 54% of the floor** |

One tool was most of it. `write_todos`, from `todoListMiddleware`, carried an
11,389-character description — 2,650 tokens, more than the other eleven tools
together four times over. 66% of it was `<example>` blocks; most of the rest
restated rules the deep prompt already gives.

### What changed

`createCompactTodoToolMiddleware` in
`src/core/agent/compact-todo-tool.middleware.ts` shows the model
`COMPACT_WRITE_TODOS_DESCRIPTION`: every rule of the tool, none of the examples.
It is installed first in all four root agents in `deep-agent-factory.ts` — deep,
analysis, the MCP advisor, and the orchestrator. The MCP advisor behind
`continue_conversation` is read-only and never plans, and the analysis prompt
forbids the tool outright; both were paying for it on every turn.

The tool was compacted rather than removed because it is load-bearing: the deep
and orchestrator prompts plan with it and the CLI renders it.

Two routes that look simpler did not survive the installed packages, and both
are recorded in that module's TSDoc so they are not re-proposed:

- `todoListMiddleware({ toolDescription })` needs deepagents' default instance
  excluded, and that exclusion filters the *whole* middleware array by name —
  a configured replacement is removed with the default, and a renamed one
  produces two `write_todos` under the empty harness profile.
- Cloning the tool in `wrapModelCall` passes `tsc` and is refused by `AgentNode`
  at the first model call, "to preserve ToolNode execution identity". Every unit
  test mocks `deepagents`, so none could have caught it; the bench did.

### After

`npm run bench:floor` on the same configuration: **4,880** tokens (system 3,904
+ 12 tools 976), `write_todos` at 291. **2,359 fewer tokens per turn, 32.6% of
the floor**, with the tool, its name and its behaviour unchanged.

### What is still not seen, and why it was not fixed here

The guard still holds 3,307, so **1,573 tokens — 32.2% of the new floor — remain
unseen**: deepagents' concatenated prompt blocks and the compact `write_todos`.
This amendment reduces the blind spot by shrinking what it hid; it does not
close it.

Closing it has a constraint that makes a quick fix wrong. Every hook Umbra
installs runs *before* deepagents' `_ToolExclusionMiddleware`, which is pushed
last, so the tool list any Umbra hook can read is the pre-exclusion list — seven
builtins larger than what is sent. Recording overhead from a hook would swap an
under-count for an over-count. A correct fix needs the excluded tool names each
harness profile registered, which Umbra owns but does not currently return. It
is recorded in `docs/deferred-work.md`. A number that looks authoritative and is
wrong in the other direction would be worse than one known to be low.

### Verification evidence

- `npm run bench:floor` — the before and after figures above; reports under
  `docs/benchmarks/results/`.
- `src/core/agent/compact-todo-tool.middleware.spec.ts` — 14 passed, against a
  real `createAgent` rather than a mock: the real `AgentNode` accepts the
  middleware; the model is bound with the compact description; other tools are
  untouched; the cloning route is refused (pinning the constraint, so a future
  LangChain that relaxes it fails this test and says so); each rule survives; the
  description stays under 1,500 characters; and two writes through a real agent
  leave only the second list, which is the claim the description makes.
- Full unit suite 1,068 passed. The one failure is `retrieval-gate.spec.ts`,
  which predates this change and touches none of its modules.
