# ADR-036 — Persistent read-only MCP conversations

| | |
|---|---|
| **Category** | MCP · Sessions · Safety · Agent runtime |
| **Author** | David Balladares (decision) · Codex (implementation) |
| **Date** | 2026-09-18 |
| **Status** | ✅ **Accepted** |

## Context

The original MCP boundary in ADR-024 exposed deterministic, one-shot repository
operations. That is correct for evidence discovery, but it leaves a client
assistant to reconstruct the purpose, clarification, and already-checked files
on every call. A multi-turn investigation therefore appears to forget its
conversation even though Umbra's CLI already persists LangGraph state by
`thread_id`.

The same boundary must not quietly become a writer. The ordinary `deep` role
can write files, and its `search_codebase` capability also includes an index
refresh. Reusing either from an MCP tool would make a `readOnlyHint` misleading.

## Decision

MCP publishes `continue_conversation`. Its first call returns an opaque UUID
`conversationId`; the caller supplies that receipt on later calls. Umbra maps
the receipt to `mcp-<UUID>` and creates a dedicated LangGraph SQLite checkpoint
in `.umbra/mcp_conversations.db`. An in-process cache only avoids rebuilding a
graph during one server lifetime. Restarting the server reconstructs the graph
against the same durable checkpoint, so the receipt — not client transcript
replay — is the continuity boundary.

The graph is an internal `mcp-advisor` role with only read capabilities:
safe file reads, ADR metadata, dependency graph queries, and semantic/literal
workspace discovery. `search_codebase_readonly` deliberately excludes
`refresh_project_index`. Its factory disables automatic reindexing because MCP
startup already owns the index lifecycle. No write, delete, test execution,
approval, shell, caller-selected root, or caller-selected checkpoint path is
available.

The tool remains read-only but is not idempotent or closed-world: it invokes the
configured chat provider and its natural-language answer can differ across
calls. Its MCP annotations state that honestly.

Native MCP elicitation is an enhancement on top of this receipt protocol, not
a prerequisite for continuity. The installed SDK supports `elicitation/create`,
but clients do not universally advertise it. Until an advisor-to-elicitation
bridge is fully exercised against supporting clients, a follow-up returned in
the visible answer is continued by calling this tool with the same receipt.
`sampling/createMessage` remains disabled; Umbra uses its own configured model
and does not spend a client's model budget.

## Consequences

### Positive

- Iterative repository questions retain their checked context across MCP calls
  and server restarts.
- The public tool cannot gain a write by inheriting the CLI's broad role.
- A client without native elicitation still has a deterministic continuation
  protocol instead of losing the investigation.

### Negative

- `continue_conversation` requires a configured chat provider; the prior
  deterministic tools do not.
- Conversation checkpoints are local state and need a future retention policy.
- Native form elicitation is intentionally not claimed until client capability
  negotiation and resume behavior are covered end to end.

## Verification evidence

- `conversation-service.spec.ts` proves UUID receipt reuse maps to one stable
  LangGraph thread and rejects caller-invented identifiers before graph startup.
- `agent-kernel.spec.ts` proves the advisor discovery capability omits index
  refresh.
- Focused MCP, agent-kernel, prompt-contract, retrieval, and ADR-catalog suites
  passed alongside `tsc --noEmit` during implementation.

## Related files

- `src/presentation/mcp/conversation-service.ts` — receipt-to-thread adapter.
- `src/presentation/mcp/tool-catalog.ts` — public tool contract and annotations.
- `src/core/agent/deep-agent-factory.ts` — dedicated advisory graph and SQLite
  checkpoint.
- `src/core/agent/agent-kernel.ts` — read-only search capability split.
