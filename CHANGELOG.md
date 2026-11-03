# Changelog

## Unreleased (source branch `2.4.3`)

- Graph answers distinguish a file absent from the served index from a file with no dependencies and suggest indexed paths with the same basename.
- Worktree failures name a non-Git pinned root or another repository. Selecting the non-Git pinned root itself reads its base index.
- `ask_codebase` identifies wrong-repository worktree arguments and abstains for explicit outside paths or Markdown files that its code index cannot cover.
- `list_adrs` returns bounded pages with module counts, text and tag filters. Tags in a human-maintained `INDEX.md` can satisfy `module` filters.
- `trace_change_impact` combines bounded inbound import traversal and Nest injection/binding consumers in one read-only call.
- A degraded index status names pending, stale or missing coverage; lexical backfill scans existing FTS IDs once rather than once per chunk.

## 2.4.2 — 2026-10-29

- Restored worktree embedding-cache reuse and index views that report their actual coverage.
- Recovered stale index leases and batched obsolete FTS-row pruning to avoid a scan per deleted chunk.
- Added reproducible index-prune and worktree-ranking benchmarks and the Codex/WSL npm release procedure.
- Published `@dastbal/umbra@2.4.2` after the source reached `main`; publication evidence is in `docs/npm-release-codex.md`.
