# ADR-028 — Hybrid retrieval requires independent evidence

| | |
|---|---|
| **Category** | RAG · Retrieval · SQLite · Quality |
| **Author** | David Balladares (decision) · Codex (record) |
| **Date** | 2026-09-03 |
| **Status** | ✅ **Accepted** — implementation and local verification in progress |
| **Refines** | ADR-024, ADR-025, ADR-026, ADR-027 |

---

## Context

ADR-025 made provider identity explicit, ADR-026 made its storage efficient,
and ADR-027 made the first-run default credential-free. None answers a separate
question: whether the four nearest vector chunks are evidence for the question.

The first paired audit reached 30% Hit@4 for both available identities on a
twenty-query corpus. Its negative control returned nearest chunks because the
retriever always rendered a top four. A plausible neighbour is not evidence,
particularly when a read-only MCP client cannot inspect the index itself.

Changing storage again loses the point of ADR-026. The repository already has
SQLite FTS5, which can add a deterministic lexical signal without another
provider call, network dependency, or comparison across vector spaces.

## Decision

`code_chunks_fts` is a local FTS5 index over each chunk's id, path, metadata,
and content. SQLite triggers on `code_chunks` insert, update, and delete keep it
in sync. The delete trigger is essential: a content change removes chunks by
foreign-key cascade, and stale lexical text would be as misleading as stale
vectors.

`RetrieverService#query` obtains twelve semantic candidates from the active
`provider/model` identity and twelve lexical candidates. It fuses **rank
positions** with Reciprocal Rank Fusion (`k=60`) and returns four candidates.
It never combines cosine and BM25 values, and never compares one provider's
score with another's.

An answer is grounded only when a candidate is present in both rankings, or a
lexical candidate directly names a query identifier in its path or metadata.
Semantic-only neighbours produce an explicit *no grounded evidence* report,
with no path, snippet, or agent-only hint.

## Consequences

### Positive

- Exact symbols and paths gain a local, free retrieval signal.
- A nonexistent feature stops being presented as four relevant files.
- FTS is backfilled from existing chunks; it requires no embedding reindex.
- The policy is portable because it relies on independent evidence, not a raw
  threshold fitted to one repository or provider.

### Negative

- Conceptual questions with only a semantic neighbour now abstain. This is the
  intended false-positive trade-off and must be measured before release.
- FTS adds local storage and trigger work on every chunk write.
- The existing vector scan remains linear; this decision improves relevance, not
  the asymptotic ranking cost deferred by ADR-026.

## Verification plan

- Unit tests cover FTS backfill, insert/update/delete triggers, cascade cleanup,
  syntax-safe query terms, deterministic rank fusion, and abstention.
- The compiled MCP binary remains the integration boundary; no in-process mock
  can prove launch pinning and client-facing output together.
- `docs/benchmarks/embedding-retrieval-corpus.json` contains 60 source-derived
  cases: 45 calibration and 15 holdout. To preserve the requested total of 50
  positives and 10 negatives, the holdout is five positives plus ten negatives.
- A future paired Vertex run needs new, exact authorization. No provider call is
  part of this implementation record.

## Related files

- `src/core/state/db.ts` — `AgentDB.initSchema`.
- `src/core/rag/lexical-index.ts` — `ensureLexicalIndex`, lexical evidence.
- `src/core/rag/hybrid-ranking.ts` — `fuseRankings`, `hasGroundedEvidence`.
- `src/core/rag/retriever.ts` — `RetrieverService#query`, `getContextForLLM`.
- `docs/benchmarks/embedding-retrieval-corpus.json` — independent quality corpus.
- `docs/adr/ADR-027-the-default-is-the-one-that-costs-nothing.md` — audit amendment.

## Amendment — 2026-09-03 · A clarification gets one bounded retry before final abstention

An abstention can mean that the repository has no evidence, or that the
operator named the concern too broadly. `ask_codebase` may therefore accept an
optional clarification and run **one** additional hybrid retrieval pass only
after the first pass lacks grounded evidence. A successful second pass remains
grounded by repository chunks; the clarification is retrieval input, not source
material.

The retry never loops, never writes the clarification into `code_chunks`, and
never reveals a semantic-only neighbour. If the second pass still lacks hybrid
or direct lexical evidence, the existing abstention contract applies unchanged.

See ADR-029 for the separate, operator-approved local vocabulary that can help
later queries without becoming code evidence.

---

## Amendment — 2026-09-08 · The abstention policy was measured, and it fails in the opposite direction

The first measurement of this record's own trade-off exists. It was taken on a
freshly rebuilt index whose corpus coverage is complete — 43 of 43 expected
paths present, so the reachable hit ceiling is 100% and nothing below is
explained by a missing chunk. Fifty-five calibration cases, Ollama
`nomic-embed-text`, through the compiled MCP binary:

| | |
|---|---|
| Hit@4 (45 positives) | **88.9%** |
| MRR | 0.706 |
| **False abstention** | **0%** |
| **Correct abstention** (10 negatives) | **0%** |
| p95 latency | 827 ms |

**The stated negative consequence did not happen.** This record predicted that
"conceptual questions with only a semantic neighbour now abstain" and called it
"the intended false-positive trade-off". Measured, the false abstention rate is
zero: the policy never once withheld a real answer. That fear was unfounded.

**The stated positive consequence did not happen either.** This record claims
"a nonexistent feature stops being presented as four relevant files". All ten
negatives returned files:

```
Where does Umbra expose a Prometheus metrics endpoint?
  -> src/core/rag/retrieval-metrics.ts, src/core/agent/deep-agent-factory.ts
Where is the MongoDB document store for chunks configured?
  -> src/core/rag/lexical-index.ts, src/core/agent/factory.ts
Where are indexing events published to a Kafka topic?
  -> src/presentation/mcp/tool-catalog.ts, src/presentation/mcp/start-mcp-server.ts
```

The mechanism is visible in the data. Grounding requires a candidate present in
both rankings, and the **common** words of these queries — *metrics*,
*endpoint*, *store*, *chunks*, *configured*, *events*, *published* — produce
both lexical and semantic hits in a repository that genuinely has metrics,
stores, chunks and events. A candidate therefore appears in both lists and
passes. Meanwhile the one term that actually discriminates — *Prometheus*,
*MongoDB*, *Kafka* — matches nothing anywhere, and nothing in the policy
requires it to.

Rank fusion agreement is a test of *consistency between two retrievers*, not of
*evidence for the question*. Two retrievers can agree confidently about a
document that has nothing to do with the subject, because they agree about the
filler.

**Nothing is retracted about the rest of the design.** Fusing rank positions
rather than mixing cosine and BM25 values remains correct, and never comparing
across vector spaces remains correct. What is wrong is only the grounding
predicate.

The correction is not implemented by this amendment, and the direction is
deliberately recorded rather than chosen: the portable form is to require a
match on a query term the index shows to be *rare*, which the FTS index can
answer from its own document frequencies — no threshold fitted to one
repository, which is the criterion this record set for itself.

Until then, `ask_codebase` will answer a question about a feature that does not
exist. That is a live defect, and it is now measured rather than suspected.

See `docs/benchmarks/results/2026-09-08-ollama-calibration.json` for the run,
and [ADR-031](./ADR-031-measure-before-building.md) for why it could not have
been measured before.

---

## Amendment — 2026-09-08 · A term the repository has never written is the evidence that was missing

The defect measured earlier the same day is closed. The grounding predicate now
has a precondition: **if a subject term of the question appears nowhere in the
indexed source, Umbra abstains and names the term.**

`findUnknownTerms` in `src/core/rag/unknown-terms.ts` asks FTS5 about each
subject term of the query. `RetrieverService#getContextForLLM` consults it
before embedding anything, so an abstention decided this way costs no provider
call at all — the same ordering argument ADR-025 §4 made for the index-presence
probe, and it shows up as halved tail latency.

### Why this satisfies this record's own criterion

ADR-028 required "independent evidence, not a raw threshold fitted to one
repository". A term's presence in the index is a property the index answers
about itself: no constant to tune, nothing to re-fit elsewhere. The claim is one
a person accepts without arithmetic — *a codebase that has never written the
name of a message broker does not integrate with that broker.*

### Three subtleties that were not obvious

**Morphology, not subject, was the first false-abstention source.** *"Where is
retrieval handled?"* against source that says `handle` must not abstain.
`termProbes` therefore probes the exact term and, when it carries an
inflectional ending, its stem as an FTS5 **prefix**. The prefix matters because
stemming only the query still fails when the code holds a different inflection:
`defined` reduced to `defin` matches nothing, while `defin*` matches `defines`.

**Taught vocabulary is known by definition.** `RetrievalMemoryService#expand`
*appends* its translations and keeps the operator's original wording, so a word
taught through `/learn-search` survives into the expanded query and looks
exactly like a word the repository has never contained — which is precisely
what it is, and precisely why ADR-029 exists. Without the `knownTerms()`
exemption this rule would have silently disabled the alias feature for the only
vocabulary it serves. This was caught by a pre-existing test, not by design.

**A corpus negative is destroyed by writing about it.** The first version of
`unknown-terms.ts` named a real corpus term in its own documentation. The
repository then contained that word, the rule correctly reported it as known,
and that case was the single negative still failing the next run. The module now
describes the *shape* of such a question and never writes the word. This is a
standing hazard for anyone documenting this area.

### Measured, on the same corpus and a clean index

| | Before | After |
|---|---|---|
| Hit@4 (45 positives) | 88.9% | 86.7% |
| MRR | 0.706 | 0.687 |
| False abstention | 0% | **2.2%** (1 of 45) |
| **Correct abstention** (10 negatives) | **0%** | **100%** |
| p95 latency | 827 ms | **455 ms** |

The one false abstention is `lexical-index`: *"Where is the FTS5 lexical code
index created and synchronized?"* The repository says *sync*, never
*synchronized*, and no inflection of this rule bridges that. It is the whole of
the Hit@4 change — 39 of 45 instead of 40 — and the operator sees the
unrecognised term named rather than four confident wrong files.

The comparison is honest but not perfectly controlled: source files were added
between the two runs, so the index differs. That easily covers a one-case Hit@4
move. It does not cover 0% to 100%.

### What this does not fix

`negative-redis` in the holdout remains uncatchable by this rule, and not
through any defect of the corpus: the word `redis` genuinely appears in this
repository's source, so *"Where is Redis used as the semantic vector store?"*
has no absent term. Distinguishing "mentioned" from "used as" needs more than
term presence. It is a fair hard case and is left standing rather than edited
away.

Report: `docs/benchmarks/results/2026-09-08-ollama-calibration.json`.

## Amendment — 2026-09-10 · The morphology gap has a second suffix class, and a review mistook the rule for a defect

Two more instances of the residual this record already names — *"the repository
says `sync`, never `synchronized`"* — were observed during an external audit of
the published 2.2.5 package, against a consumer repository:

| Query term | What the repository writes | Why the probe misses it |
| --- | --- | --- |
| `globally` | `global` | `-ly` is derivational; `INFLECTIONS` covers `ing`, `ed`, `es`, `s` |
| `resume` | `checkpoint` | not morphology at all — a synonym |

The first is the same defect class as `synchronized` with a different suffix, and
it is worth separating the two classes explicitly. `INFLECTIONS` bridges
**inflection**. `-ly`, `-ion` and `-ance` are **derivation**, and no amount of
adding endings to that list turns it into a stemmer. Whether this project wants a
derivational stemmer, a small closed set of adverbial forms, or nothing at all is
an open question and is recorded in `docs/deferred-work.md` rather than decided
here.

The second is not this rule's problem. A synonym is exactly what ADR-029's
approved aliases exist for, and `RetrievalMemoryService#approve` implements it.
The gap is reachability: nothing on the MCP surface can call it, so a consumer
running `umbra mcp` has no way to teach the vocabulary the gate is asking them
for. The abstention names the term and then offers no route to resolve it. That
is recorded as a candidate too, in the shape of turning the abstention into a
question rather than a refusal.

### Recorded because the review reached the opposite conclusion

The audit reported this rule as its first defect — *"the term gate is a hard AND,
one absent word aborts the query"* — which is an accurate description of the
mechanism and the wrong conclusion about it. The reasoning that makes it correct
is already in this record's 2026-09-08 amendment: rank agreement measures
consistency between two retrievers rather than evidence for the question, and the
alternative of a tuned score threshold was rejected on evidence, because term
presence is a property the index answers about itself with no constant to fit.

Noting it here so the next review finds the answer in the record instead of
rediscovering the mechanism and reading it as a bug. The measured cost of the
rule — correct abstention 0% → 100% for false abstention 0% → 2.2% — is the part
that makes it a trade rather than an oversight, and it is one paragraph above.

## Amendment — 2026-09-18 · Syntax words do not identify a code subject

An external package review exposed a lexical failure unrelated to the absence
gate: a question such as “which use case imports a FIRST quote” could rank
large module files because `import` occurs in every TypeScript import block.
That word describes the requested relationship, not the code subject.

`lexicalTerms` in `src/core/rag/lexical-index.ts` now removes a small set of
TypeScript syntax words only when the same question contains another searchable
term. A question solely about `import` remains searchable, so this is not a
global stoplist and does not erase a legitimate operator request. The same
normalization feeds the direct path/metadata evidence check, preventing syntax
filler from independently grounding an unrelated file.

After rank fusion, `preferExecutableEvidence` in
`src/core/rag/hybrid-ranking.ts` keeps hybrid evidence above lexical or semantic
only results, then shows a method or function before a class signature. This is
a presentation order over already-grounded candidates; it neither combines raw
BM25 with vector scores nor weakens the abstention predicate.

Verification on 2026-09-18: focused lexical, hybrid-ranking, retriever,
GraphRAG, AST-chunker, integrity, MCP-catalog, and SDK-server Jest suites passed (87 tests), and strict
TypeScript compilation passed. No provider benchmark was run, so no new quality
metric is claimed.
