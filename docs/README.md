# Documentation Index

The repository [README](../README.md) is the canonical guide for installation,
CLI usage, configuration, security behavior, and migration notes.

- [Architecture](ARCHITECTURE.md) explains the active Deep-agent design and its
  historical context.
- [GraphRAG Detective](graphrag-detective.md) explains the evolving local
  retrieval laboratory, its bounded graph traversal, and policy promotion.
- [Architecture decisions](adr/) record durable technical decisions.
- [Deferred work](deferred-work.md) records work that was scoped and
  deliberately not implemented, including any open defect found while scoping
  it. Read it before proposing a feature that may already be planned there.
- [Retrieval benchmarks](benchmarks/results/README.md) hold the committed
  measurement series and the protocol for comparing two runs. A quality claim
  about retrieval belongs there before it belongs in prose.
- [Reports](reports/) are narrative measurement records — what was measured, on
  which commit, and what the numbers cannot support. The 2026-09-10 pair covers
  retrieval cost and latency, and the issue drafts that came out of it.
- [Migrating to Umbra 2.0](MIGRATING-TO-UMBRA.md) maps the former package and
  command names to the public Umbra identity.
- [LangChain reference index](langchain-llms-index.md) is reference material,
  not a product guide.

Commands shown in older documents may describe retired classic and graph paths.
Use `umbra init`, `umbra doctor`, `umbra analyze`, `umbra deep`, and
`umbra orchestrate` as documented in the root README.
