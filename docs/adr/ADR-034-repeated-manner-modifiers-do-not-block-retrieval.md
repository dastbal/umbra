# ADR-034 — Repeated manner modifiers do not block retrieval

| | |
|---|---|
| **Category** | RAG · Retrieval · Abstention |
| **Author** | David Balladares (decision) · Codex (record) |
| **Date** | 2026-09-17 |
| **Status** | Accepted |
| **Refines** | ADR-028 |

---

## Context

ADR-028 correctly refuses a question whose subject never appears in the indexed
repository. The original all-or-nothing term gate also refused a grounded
question when it carried an absent repeated manner phrase such as `byte by
byte`. In that construction, `byte` describes the requested granularity; it is
not necessarily a requested integration, symbol, or feature.

Dropping every unknown word would reverse ADR-028 and allow a missing product
name to be carried by generic matches. The exception must therefore be structural
and observable, not a general synonym or fuzzy-match rule.

## Decision

`assessUnknownTerms` keeps the original FTS absence probes and classifies an
unknown term as an ignored modifier only when all of these facts hold:

1. The original query contains the repeated pattern `X by X`.
2. `X` is absent from the indexed corpus.
3. At least two other subject-bearing terms are grounded.

All other unknown terms remain strict and cause the existing abstention. The
original query is still sent unchanged to hybrid retrieval; only the pre-query
absence gate is relaxed. The typed `ask_codebase` result carries
`ignoredModifiers`, so a client can see that an explicit degradation occurred.

## Consequences

### Positive

- Natural phrasing no longer prevents a retrieval that already has several
  grounded subjects.
- A question whose only possible subject is absent still receives the strong
  ADR-028 abstention.
- The client can distinguish relaxed wording from a full evidence match.

### Negative

- This intentionally handles one linguistic construction, not synonyms,
  spelling correction, or generic stop-word expansion.
- The threshold is a safety rule; its effect on consumer retrieval quality still
  needs a dedicated benchmark case.

## Verification evidence

- Unit tests prove that a grounded `byte by byte` query proceeds and that
  `bytes` remains strict when it is the only possible subject.
- Focused discovery, schema chunking, retrieval, indexer, and MCP SDK suites:
  41 tests passed on 2026-09-17.
- `node node_modules/typescript/bin/tsc --noEmit` passed on 2026-09-17.

## Related files

- `src/core/rag/unknown-terms.ts` — `assessUnknownTerms`, `repeatedMannerTerms`.
- `src/core/rag/retriever.ts` — `RetrieverService#getContext`.
- `src/core/rag/graphrag.ts` — `GraphRagSearchResult`, `GraphRagService#executePlan`.
- `src/core/tools/read-only-executions.ts` — `codebaseSearchDataSchema`, `toCodebaseSearchData`.
- `src/presentation/mcp/tool-catalog.ts` — `publishAskCodebase`.

## Amendment — 2026-09-23 · The code left this record's decision for five days

From `09154c1` (2026-09-18) until this amendment, `assessUnknownTerms` did not do
what this record decides. *"All other unknown terms remain strict"* became "every
unknown term is dropped once any other subject is grounded", and the test this
record cites as evidence — `bytes` stays strict when it is the only possible
subject — was rewritten to expect the opposite. Measured on the live
calibration split, correct abstention fell to 0.1.

The decision above stands and the code is back on it. `droppedTerms`, added by
that commit, remains in the result schema and is always empty. The measurement
and the reasoning are in ADR-028's amendment of the same date.

The `X by X` rule itself was never affected: it still needs two grounded
subjects, and its test was unchanged throughout.
