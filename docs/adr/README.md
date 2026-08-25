# Architectural Decision Records — Umbra

Index of every decision record in this module. **Read this table first**, match
your task against the `Tags` column, and open only the records that match.
Reading all of them costs a lot of context and is only warranted on an explicit
deep audit.

When a record and the code disagree: the **code** is authoritative for what the
system does now, the **record** for why it was built that way. A disagreement
means the record needs an amendment — flag it instead of silently picking a side.

| ADR | Status | Tags | Decision |
|---|---|---|---|
| [001](./ADR-001-agent-orchestration-context.md) | Accepted | `orchestration`, `subagents`, `context` | Task size selects the topology: small tasks run a single agent, larger ones use one delegation level (`Supervisor → Researcher / Coder / Verifier`). |
| [002](./ADR-002-model-routing-and-bounded-analysis.md) | Accepted | `models`, `routing`, `evidence`, `cost` | Model resolution order is explicit `--model` > `AGENT_MODEL` > project profile, and orchestrator roles resolve their own profile without reading the env var. |
| [003](./ADR-003-on-demand-readme-index.md) | Accepted | `rag`, `readme`, `context-budget` | `list_readmes` builds a cached path/title index in `.agent/` instead of injecting README bodies into context. |
| [004](./ADR-004-on-demand-adr-index.md) | Accepted | `adr`, `index`, `context-budget` | `list_adrs` builds a cached ADR catalog in `.agent/` with bounded context, so decision history is consulted without reading every record. |
| [005](./ADR-005-incomplete-tool-checkpoint-recovery.md) | Accepted | `sessions`, `checkpoint`, `recovery` | Named sessions interrupted after a tool result are recovered rather than left in an unusable checkpoint. |
| [006](./ADR-006-vertex-tool-cycle-streaming-fallback.md) | Accepted | `vertex`, `streaming`, `tools`, `provider` | Tool cycles use a non-streaming Vertex transport, because the streamed path rejects completed cycles. |
| [007](./ADR-007-self-healing-tool-cycle-sessions.md) | Accepted | `sessions`, `recovery`, `resilience` | A session whose tool cycle the provider rejected resets itself instead of failing the run. |
| [008](./ADR-008-bounded-interactive-iteration-audit.md) | Accepted | `iteration-budget`, `telemetry`, `limits` | Interactive Deep-agent iterations are bounded and joined to performance telemetry. |
| [009](./ADR-009-executable-agent-security-policy.md) | Accepted — amended 2026-08-25 | `security`, `authorization`, `policy`, `tools` | `AgentSecurityPolicy` evaluates every filesystem and verification action in code, returning `allow` / `require_approval` / `deny`. **Amended:** two of its claims did not hold — see ADR-011. |
| [010](./ADR-010-umbra-public-package-and-cli.md) | Accepted — amended 2026-08-25 | `packaging`, `cli`, `identity`, `auth` | The published package is `@dastbal/umbra` with a single `umbra` binary and local ADC auth commands. **Amended:** the root command's routing and an unversioned build config. |
| [011](./ADR-011-path-containment-and-real-approval.md) | Accepted | `security`, `path-traversal`, `hitl`, `approval`, `prompt-injection`, `pricing` | Path containment resolves the final component and returns the real path; `require_approval` raises the LangGraph interrupt the CLI already renders; file content is framed as untrusted data. |
| [012](./ADR-012-cli-wait-indicator-and-transient-line-contract.md) | Accepted | `cli`, `rendering`, `terminal`, `ux` | The wait indicator is a phrase with a highlight sweeping across it, and every transient line declares its printable width so it can be erased exactly and never wraps. |
