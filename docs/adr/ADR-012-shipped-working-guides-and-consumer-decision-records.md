# ADR-012: Ship the working guides and let the agent record decisions in the consumer's project

**Category:** Packaging, agent prompt, project scaffolding
**Author:** Claude (implementation), directed by David Balladares
**Date:** 2026-08-26

## Status

Accepted — 2026-08-26

## Context

Two defects were found while reviewing whether Umbra could document its own
architectural decisions inside a project that installs it.

1. **The skill library never left this repository.** `package.json` declared
   `files: ["dist", "README.md"]`, so `skills/` was not published. The system
   prompt built by `buildSystemPrompt` routes every task through a keyword →
   skill map and then falls back to *"If `skills/` does not exist, proceed with
   your best NestJS/DDD judgment."* In any consumer project that fallback was
   the only branch that could ever run: **all twelve guides were inert outside
   this repository**, not only the missing one. `umbra init` created the runtime
   policy in `.agent/` and nothing else.

2. **The agent could read decision records but not write them.** `list_adrs`
   (ADR-004) builds its catalog from `path.join(rootDir, 'docs', 'adr')` — the
   root of the project being worked on, so the read path was already generic and
   correct. There was no counterpart for writing one, and no guide describing
   how.

A third point framed the design, raised by David and confirmed against the
package manifest: the eleven records in this repository's `docs/adr/` describe
**how this agent was built**. They are of no use to a consumer and must not be
published. `docs/` was already absent from `files`, so that half was already
right and stays untouched. The distinction to encode is therefore between a
*guide*, which travels, and a *record*, which stays in the project that produced
it.

## Decision

### A generic decision-recording guide, written for the consumer's project

`skills/document-decision.md` states explicitly that `docs/adr/` means the target
project's directory, never the agent's own. It carries the parts of the practice
that are project-independent: the write/do-not-write table, index-first reading
via `list_adrs`, sequential numbering, the required sections, citation by symbol
rather than line number, amend-never-delete, and the prohibition on fabricated
alternatives or measurements. It names no Umbra internals.

### Writing is conditional, never automatic

The `ARCHITECTURE DECISION INDEX` block of `buildSystemPrompt` in
`src/core/agent/deep-agent-factory.ts` now separates reading from writing. A
record is written only when finished work moved a layer boundary, a persistence
or migration strategy, an auth or safety boundary, a public contract, a provider
choice, or accepted a knowing trade-off. Routine refactors, renames, obvious bug
fixes, and reversible local choices are named as explicitly excluded. A keyword
row (`ADR / decision record / document this decision / supersede`) was added to
the skill map for the case where the user asks directly.

### The guides are published and scaffolded on init

- `package.json` — `files` gains `skills/*.md`. The glob is deliberate: it ships
  the thirteen top-level guides and excludes `skills/run-nestjs-ai-agent/`,
  which documents how to develop *this* agent.
- `src/core/config/workspace-scaffold.ts` — `resolvePackagedSkillsDir` walks
  upward from `__dirname` (not `process.cwd()`, which is the consumer's project)
  looking for a `skills/` directory containing `document-decision.md`, resolving
  identically from `src/` under ts-node and from `dist/` when installed.
  `ensureWorkspaceSkills` copies only top-level `.md` files, never overwrites a
  file the project already has, and treats source-equals-target as "all
  preserved" so running `umbra init` inside this repository is a no-op.
  `ensureAdrIndex` seeds `docs/adr/README.md` with the tagged index table that
  makes `list_adrs` cheap to act on.
- `src/bin/cli.ts` — `umbra init` now reports the policy, then the installed and
  preserved guide counts, then the index. Scaffolding failure is reported
  without discarding a successfully created policy.

## Trade-offs actually evaluated

| Approach | Pros | Cons | Decision |
|---|---|---|---|
| Copy the guides into the consumer project on `init` | The team can edit a guide to fit their conventions; no runtime path resolution during a task | Copies diverge from the package over time; a later `init` will not update an edited guide | **Chosen.** Guides are working agreements a team must be able to amend; a copy the team owns is the point, not a defect |
| Resolve the guides from `node_modules` at task time | Always current with the installed version; no duplication | The team cannot adapt a guide, and `safe_read_file` is contained to the workspace root, so the agent could not read them at all | Rejected — incompatible with path containment (ADR-011) |
| Inject the guide bodies into the system prompt | No filesystem dependency | Spends the context budget every turn on guides the task does not need — the failure ADR-003 and ADR-004 exist to avoid | Rejected |
| Always append an ADR when a coding task finishes | Nothing is ever left undocumented | Produces fabricated records: the model fills required sections to satisfy the format, and trivial entries bury the significant ones | Rejected — conflicts with the guide's own no-fabrication rule |

## Consequences

**Positive**

- Every guide, not only the new one, becomes reachable in a consumer project;
  the prompt's "no skills" fallback stops being the only live branch.
- A consumer project accumulates its own `docs/adr/`, readable by `list_adrs` on
  the next session, with the index already shaped for tag filtering.
- The internal and consumer record sets remain fully separate: `docs/` is still
  unpublished, and the guide names no path in this repository.

**Neutral**

- An installed guide is a copy the team owns. `init` preserves local edits and
  will not propagate an upstream guide revision to a project that has one.

**Negative**

- `files` now carries a second, hand-maintained glob. A new top-level guide is
  published automatically; a guide added inside a new subdirectory is not, and
  the `resolvePackagedSkillsDir` marker file must keep its name for resolution
  to work in an installed package.

## Verification Evidence

- `node node_modules/typescript/bin/tsc --noEmit` — exit 0.
- `node node_modules/jest/bin/jest.js --runInBand --forceExit` — 35 suites
  passed, 236 passed / 4 skipped of 240 tests, 8.9 s. Eight of those tests are
  new, in `workspace-scaffold.spec.ts`: install, non-markdown and subdirectory
  exclusion, no-overwrite of an edited guide, idempotence with a populated
  index, source-equals-target, the missing-library error, and both resolution
  branches.
- `umbra init` executed in an empty scratch directory outside the repository:
  reported `Working guides: 13 installed, 0 preserved`, wrote the thirteen
  top-level guides, omitted `run-nestjs-ai-agent/`, and created
  `docs/adr/README.md`.
- `npm pack --dry-run --json`: the tarball lists thirteen `skills/*.md` entries
  and **zero** `docs/` entries, confirming the internal records stay unpublished.
- Not verified: behavior of the new prompt clause against a live model. No
  session was run, so no claim is made about how often the agent judges a
  decision durable enough to record.

## DDD layer mapping

| Layer | Component | Role |
|---|---|---|
| Core / config | `src/core/config/workspace-scaffold.ts` | Resolves the packaged library and scaffolds guides plus the record index |
| Core / agent | `src/core/agent/deep-agent-factory.ts` | Prompt contract: when a record is written and when it is not |
| Presentation | `src/bin/cli.ts` | `umbra init` reporting and failure isolation |
| Guides | `skills/document-decision.md` | Project-independent procedure, shipped to consumers |

## Related Files

- `skills/document-decision.md` — the shipped guide
- `src/core/config/workspace-scaffold.ts` — `resolvePackagedSkillsDir`,
  `ensureWorkspaceSkills`, `ensureAdrIndex`, `SKILL_LIBRARY_MARKER`
- `src/core/config/workspace-scaffold.spec.ts` — eight scaffolding tests
- `src/core/agent/deep-agent-factory.ts` — `buildSystemPrompt`, its skill map
  row and `ARCHITECTURE DECISION INDEX` block
- `src/bin/cli.ts` — the `init` command action
- `src/core/tools/adr-index.ts` — `buildAdrIndex`, `discoverAdrs`; the read path
  this decision complements
- `package.json` — the `files` array
