# ADR-033 — Prisma schemas are labelled configuration evidence

| | |
|---|---|
| **Category** | RAG · Indexing · Evidence |
| **Author** | David Balladares (decision) · Codex (record) |
| **Date** | 2026-09-17 |
| **Status** | Accepted |
| **Refines** | ADR-030, ADR-032 |

---

## Context

The TypeScript-only index can retrieve code that reacts to a database invariant
while omitting the schema declaration that enforces it. For example, a payment
repository can catch Prisma `P2002` and return a conflict while the authoritative
`@unique` field remains outside Umbra's corpus. This is an evidence gap, not a
ranking failure: no retrieval policy can return a file that was never indexed.

The same issue applies to schema-owned decimal precision, relation actions, and
database indexes. However, treating every text file as source would make
migration history, generated configuration, stale JSON, and secrets look equally
authoritative.

## Decision

`WorkspaceDiscoveryService` discovers each root-contained
`prisma/schema.prisma` alongside its declared TypeScript source. A
`PrismaSchemaChunker` emits one `config` chunk for each Prisma `model` or `enum`,
preserving the original lines and attaching `artifactKind: "prisma-schema"`.
Schemas with no model or enum still yield one file-level configuration chunk so a
nonempty authoritative artifact cannot become a false empty-index state.

`IndexerService` embeds these chunks using the same durable transaction as
TypeScript chunks, but runs dependency and NestJS wiring backfills only over
TypeScript. The MCP `ask_codebase` DTO preserves the artifact label, so a client
can distinguish a database constraint from application code.

Migration SQL, non-authoritative `.prisma` files, arbitrary JSON, YAML, and
general documentation remain out of scope. They have different truth and
lifecycle rules and need separate decisions before indexing.

## Consequences

### Positive

- A question about idempotency can retrieve both the enforcement boundary in
  `schema.prisma` and code that handles a duplicate error.
- Constraints remain source evidence, not an inferred “business guarantee”
  produced by a model.
- Existing TypeScript graph semantics stay unchanged.

### Negative

- A Prisma consumer re-embeds model-sized schema chunks when it first upgrades.
- Current migration history is intentionally not searchable as current schema
  truth.
- Other ORMs and configuration formats remain unsupported rather than silently
  approximated.

## Verification evidence

- Focused discovery, Prisma chunking, retrieval-gate, indexer, and MCP SDK
  suites: 41 tests passed on 2026-09-17.
- `node node_modules/typescript/bin/tsc --noEmit` passed on 2026-09-17.
- The compiled package and a consumer-repository semantic benchmark remain
  unverified at this point; source-level tests do not prove publication state.

## Related files

- `src/core/config/workspace-discovery.ts` — `WorkspaceDiscoveryService#discover`, `discoverPrismaSchemas`.
- `src/core/rag/prisma-schema-chunker.ts` — `PrismaSchemaChunker#analyze`.
- `src/core/rag/indexer.ts` — `IndexerService#indexDiscoveredProject`, `indexSingleFile`.
- `src/core/rag/embedding-input.ts` — `embeddingInputFor`.
- `src/core/tools/read-only-executions.ts` — `codebaseSearchDataSchema`, `toCodebaseSearchData`.
- `src/presentation/mcp/tool-catalog.ts` — `publishAskCodebase`.
