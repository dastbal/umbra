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
