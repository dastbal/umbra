# ADR-039: Trace structural change impact in one bounded read

- **Date:** 2026-11-03
- **Status:** Accepted
- **Module:** Read-only code graph tools
- **Decision owners:** David Balladares (objective); Codex (implementation and record)

## Context

Agents reported that several Umbra calls often gave no more help than a text
search. A useful exception was NestJS wiring: the indexed graphs could answer
who provides or injects a service. To assess a change to one file, however, an
agent had to combine inbound imports with NestJS consumers itself. This is a
structural question over data Umbra already indexes; it needs a compact answer
that identifies what the index does and does not cover.

## Decision

Publish `trace_change_impact` through
`src/presentation/mcp/tool-catalog.ts#publishChangeImpact`. It takes an indexed,
repository-relative `filePath`, optional import `depth` (default 2, allowed 1–4),
and optional `worktree`. With a worktree selected, it reads that checkout's
index view without embedding calls; otherwise it reads the pinned base index.

`src/core/tools/read-only-executions.ts#executeChangeImpact` first checks
`file_registry`. A missing file returns typed `FILE_NOT_INDEXED`, with up to
eight candidate paths, instead of saying the file has no dependents. For an
indexed file, it follows inbound `dependency_graph` edges breadth-first,
deduplicating paths and stopping at the requested depth. It also takes
`className` values from that file's indexed chunk metadata and finds exact
token matches in `nest_injections` and `nest_bindings`. The response identifies
each relation as `import`, `injection`, or `binding`.

The result holds at most 100 affected relations. When more relations exceed
that bound, the response is `partial` with `truncated: true` and a narrowing
action. `NO_IMPACT` means no
relations were found **within this index and traversal**, not that a change is
safe at runtime. The tool makes no runtime execution claim and does not scan
unindexed tests, dynamic behavior, or downstream consumers outside the served
repository. Graph coverage remains subject to the limits recorded in
[ADR-030](./ADR-030-discovery-based-indexing-and-decision-catalogs.md).

## Consequences

- **Positive:** One call joins importer paths and NestJS injection and binding
  evidence for a change review. Missing paths and bounded results carry typed
  meaning rather than a misleading empty list.
- **Neutral:** The answer uses existing graph and chunk tables; it adds no new
  indexing scope or embeddings.
- **Negative:** Exact `className` token matching may miss alias or dynamic
  wiring. Duplicate paths can appear for distinct Nest relations. The 100-row
  cap and the selected import depth can omit affected code, which is reported
  as partial or reflected in the requested depth.

## Verification Evidence

- `src/core/tools/change-impact.spec.ts` passed with the full 2.4.3 test run.
  Its fixtures cover combined import and NestJS results, a missing indexed
  file, a cyclic graph with a depth limit, and a wide graph marked partial.
- The 2.4.3 branch verification before this documentation change passed
  `npm run type-check`, `npm run lint`, and Jest: 125 suites and 1,195 tests
  passed; one suite and one test were skipped. This is code verification, not
  a measurement of usefulness in agent runs.
- Agent usefulness after a release requires a separate measurement; these
  checks establish the code contract only.

## Related Files

- `src/core/tools/read-only-executions.ts` — `executeChangeImpact`,
  `changeImpactResultSchema`.
- `src/presentation/mcp/tool-catalog.ts` — `publishChangeImpact`.
- `src/core/tools/change-impact.spec.ts` — bounded impact fixtures.
- `src/core/config/git-worktrees.ts` — `resolveWorktree`.
- `src/core/rag/worktree-view.ts` — `WorktreeViewService.read`.
