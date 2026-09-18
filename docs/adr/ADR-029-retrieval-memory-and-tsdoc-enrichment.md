# ADR-029 — Retrieval memory and TSDoc stay separate from code evidence

| | |
|---|---|
| **Category** | RAG · Retrieval · Privacy · CLI |
| **Author** | David Balladares (decision) · Codex (record) |
| **Date** | 2026-09-03 |
| **Status** | ✅ **Accepted** |
| **Refines** | ADR-024, ADR-025, ADR-028 |

---

## Context

Hybrid retrieval can correctly abstain when a broad request lacks independent
evidence. A later clarification may identify the right code, but placing either
the failed request or conversational filler into `code_chunks` would make user
language look like repository source. It would also contaminate the FTS corpus
and cause a phrase such as “bello” to become a misleading retrieval signal.

The pre-existing chunks expose class, method and decorator metadata, but class
signatures are rebuilt from AST and did not retain their TSDoc as a structured
field. The indexer scans TypeScript source only; Markdown documentation is not
part of this decision.

## Decision

`NestChunker#analyze` records declaration TSDoc as
`ChunkMetadata.documentation`. `enrichExistingTSDoc` in
`src/core/rag/tsdoc-enrichment.ts` applies that field to existing matching rows
by path, chunk kind, source span and symbol name. It changes metadata only:
chunk text, IDs, provider/model rows and vectors remain untouched. FTS already
indexes metadata and its existing update trigger keeps the lexical view current.

`RetrievalMemoryService` in `src/core/rag/retrieval-memory.ts` owns a separate
local `retrieval_aliases` table. It stores normalized approved terms, useful
clarification terms and code paths returned with grounded evidence. It does not
store raw prompts, model output, snippets or vectors. Conversational filler is
discarded before it can become an alias.

CLI and MCP share `RetrieverService` and therefore read the same aliases.
`ask_codebase` accepts an optional `context`; after an ungrounded first search
it runs at most one contextual retry. Only the CLI command `/learn-search` can
approve a successful contextual candidate and write an alias. MCP remains
read-only under ADR-024.

## Consequences

### Positive

- TSDoc becomes a weighted lexical signal for the declaration it explains.
- A user can teach their own project vocabulary without re-embedding source.
- MCP benefits from approved aliases without gaining a write or confirmation
  channel.

### Negative

- A contextual retry can spend one extra query embedding when the first pass
  abstains; it is explicitly bounded to one.
- TSDoc additions to existing chunks improve FTS immediately, but their old
  vectors remain code-only until a separately authorized content reindex.
- This does not index general Markdown documentation; that scope remains
  deferred.

## Verification evidence

- Unit tests cover TSDoc extraction and idempotent metadata enrichment, lexical
  visibility, noise removal, approved-only aliases and the CLI command registry.
- The compiled MCP verification remains required because its schema and
  read-only boundary are observable only through the published binary.
- A new paired provider benchmark is deliberately not included in this record:
  it needs fresh authorization for the exact Vertex query count.

## Related files

- `src/core/tools/ast/chunker.ts` — `NestChunker#analyze`, `documentationOf`.
- `src/core/rag/tsdoc-enrichment.ts` — `enrichExistingTSDoc`.
- `src/core/rag/retrieval-memory.ts` — `RetrievalMemoryService`.
- `src/core/rag/retriever.ts` — `RetrieverService#getContextForLLM`.
- `src/core/tools/rag-tools.ts` — `askCodebaseTool`.
- `src/presentation/cli/slash-commands.ts` — `buildSlashCommands`.
- `src/presentation/mcp/tool-catalog.ts` — `publishAskCodebase`.

## Amendment — 2026-09-18 · Documentation stays metadata, not duplicate class evidence

`NestChunker#extractClassContext` previously copied TSDoc and every import
statement into every `class_signature` chunk. A review showed that descriptive
TSDoc and Swagger-heavy declarations could then outrank the executable method
that actually implements the answer.

The chunker now retains TSDoc exclusively in `ChunkMetadata.documentation`, as
this record originally intended, and leaves imports to the bounded dependency
presentation. A class-context header is reconstructed from parsed modifiers,
type parameters, `extends`, and `implements` clauses; it is never replaced with
a generic `export class` template. This preserves `abstract` ports and inherited
error classes without storing duplicate import noise.

Verification on 2026-09-18: the AST regression fixture covers an abstract,
generic, extending and implementing class with `super(message)`; the focused
retrieval suites and strict TypeScript compilation passed.
