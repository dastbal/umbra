# ADR-035 — Live workspace evidence complements semantic retrieval

| | |
|---|---|
| **Category** | Retrieval · Tools · MCP · Security |
| **Author** | David Balladares (decision) · Codex (implementation) |
| **Date** | 2026-09-18 |
| **Status** | ✅ **Accepted** |

## Context

`ask_codebase` searches the durable semantic index. That is the right tool for a
conceptual question, but it cannot locate an exact symbol in an artifact that is
deliberately outside that index. A payment repository made the gap concrete:
the code could describe the reaction to a unique-constraint collision while the
authoritative Prisma rule itself lived in `prisma/schema.prisma`.

ADR-033 adds that one authoritative Prisma artifact to the index. It does not
make every SQL, JSON, YAML, contract, or configuration file semantic evidence,
and it must not. Indexing arbitrary configuration would mix current rules,
history, generated files, and credentials without a parser or a retrieval
contract for each class.

DeepAgents supplies a filesystem `grep`, but enabling its filesystem backend
would inject more than a safe search capability. Umbra must exclude secrets and
generated state **before** reading content, preserve one pinned root, and give
MCP the validated result contract from ADR-032. Those guarantees cannot depend
on a provider-specific auto-injected tool.

## Decision

Umbra exposes two read-only, index-independent capabilities:

- `inspect_project` maps safe artifact types and exclusions from metadata only.
- `search_workspace` performs a bounded, literal search over safe text
  artifacts and returns paths, one-based lines, short excerpts, artifact type,
  exclusions, and truncation.

`WorkspaceEvidenceService` in `src/core/config/workspace-evidence.ts` is bound
to the root that Umbra already resolved. Neither Deep nor MCP accepts a root
from a tool argument. Before any content is read, the service excludes dot-env
files, certificate/key extensions, dependency and agent state directories,
lockfiles, binaries, symlinks, and unsupported formats. It never runs a shell
command, calls an embedding provider, changes the index, or writes to the
workspace.

Search results are **live literal matches**, not semantic ranking or proof that
a line is the current business rule. Source excerpts reaching a model remain
framed as untrusted file content. File, byte, and match caps make an incomplete
scan explicit instead of returning a deceptively complete answer.

The existing `search_codebase` agent capability now grants all three discovery
levels: `ask_codebase` for semantic evidence, `search_workspace` for a known
literal, and `inspect_project` for workspace awareness. MCP publishes the same
two operations through ADR-032's validated structured-result boundary.

DeepAgents' current filesystem backend remains a candidate implementation
detail, not a dependency of this security boundary. A future compatibility
spike may prove that its current Gemini schema works, but it may not bypass
Umbra's pre-read policy or expose its write tools.

## Consequences

### Positive

- An agent can find exact symbols in safe, unindexed artifacts without forcing
  broad semantic indexing.
- A consumer can see that Prisma, SQL, YAML, JSON, and similar artifact types
  exist before deciding what deserves a parser and an index contract.
- Gemini, Ollama, Claude, Deep, and MCP receive the same provider-neutral
  operation and do not depend on a model owning filesystem access.

### Negative

- Literal matches can be noisy and do not rank relevance; callers must still
  read the cited file and distinguish rule, history, and documentation.
- A bounded scan can return `partial`; narrowing by repository-relative path is
  required before treating its absence as meaningful.
- The initial eligible artifact list is intentionally small. Adding a type to
  semantic indexing remains a separate parser-and-evaluation decision.

## Verification evidence

- `workspace-evidence.spec.ts` covers metadata inventory, Prisma/SQL/YAML
  literal matches, secret exclusion, bounded results, and root containment.
- `agent-kernel.spec.ts` proves code-search roles receive semantic, literal,
  and metadata tools without arbitrary shell execution.
- `tool-catalog.spec.ts` proves MCP advertises both operations and applies its
  pinned-root gate.
- Focused Jest suites passed: 3 suites, 26 tests.
- `tsc --noEmit` passed.

## Amendment — 2026-09-18 · Explicit forbidden targets are blocked

A direct request for a secret-like file was initially skipped before its
contents were read, but was reported as `empty`. That preserved confidentiality
but gave the wrong meaning: `empty` means a permitted scan completed without a
match. Direct paths covered by the pre-read exclusion policy now fail as
`blocked` with `WORKSPACE_SEARCH_ERROR`. Recursive scans continue to skip and
count excluded artifacts, because they are not an explicit request to inspect
one forbidden target.

`workspace-evidence.spec.ts` covers the boundary at the service and
`read-only-executions.workspace.spec.ts` verifies the typed MCP-facing outcome.

## Related files

- `src/core/config/workspace-evidence.ts` — `WorkspaceEvidenceService`,
  `WorkspaceEvidenceError`.
- `src/core/config/workspace-evidence.spec.ts` — safe artifact and literal
  search coverage.
- `src/core/tools/read-only-executions.ts` — `executeProjectInventory`,
  `executeWorkspaceSearch`, `formatWorkspaceSearchForModel`.
- `src/core/tools/rag-tools.ts` — `inspectProjectTool`, `searchWorkspaceTool`.
- `src/core/agent/agent-kernel.ts` — `CAPABILITY_REGISTRY`.
- `src/presentation/mcp/tool-catalog.ts` — `publishProjectInventory`,
  `publishWorkspaceSearch`.
- `src/presentation/mcp/tool-catalog.spec.ts` — MCP publication and root-gate
  coverage.
