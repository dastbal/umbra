# `src/presentation/mcp/` — Umbra as a read-only MCP server

Umbra's third presentation adapter, beside `cli/` and `http/`. It publishes what
Umbra knows about **one** repository to any Model Context Protocol client —
Claude Code, Codex, Cursor, Gemini CLI — over stdio.

Decided in [ADR-024](../../../docs/adr/ADR-024-umbra-as-a-read-only-mcp-server.md).
Pluggable embeddings, which is what lets `ask_codebase` be published without a
Google account, are [ADR-025](../../../docs/adr/ADR-025-embeddings-are-chosen-not-assumed.md).

## Running it

```bash
umbra mcp --root /path/to/repo
```

| Flag | Meaning |
|---|---|
| `--root <path>` | **Required.** The repository to serve. Fixed at launch; no tool argument can change it |
| `--embeddings <vertex\|ollama>` | Embedding provider for semantic search. Default: whatever `.umbra/agent.config.json` says, else `vertex` |
| `--no-index` | Skip warming the semantic index at launch |

Registering it with a client is one entry pointing at the binary with those
arguments. Removing it is deleting that entry — there is nothing else to undo.

## What it publishes

| Kind | Name | Cost |
|---|---|---|
| Tool | `list_adrs` | free |
| Tool | `query_dependency_graph` | free |
| Tool | `run_integrity_check` | free (runs `tsc --noEmit`) |
| Tool | `ask_codebase` | embeds the query — **published only when embeddings are available** |
| Resource | `umbra://adr-index` | free |
| Resource | `umbra://index-status` | free |
| Prompt | one per `skills/*.md` | free |

`ask_codebase` is advertised conditionally on purpose. Telling a foreign model
about a tool that fails on first use is the defect
[ADR-013](../../../docs/adr/ADR-013-subagent-tool-exclusion-and-provider-diagnostics.md)
recorded, and it is worse here because the tool list is fixed at launch and
cannot be corrected mid-session. When it is withheld, `stderr` says why and
names the command that fixes it.

## The five constraints this module exists to honour

1. **No model.** Nothing here instantiates a chat model, builds a prompt, or
   runs an agent loop. The only model call in the whole mode is the embedding
   inside `ask_codebase`.
2. **No writes.** Not caution — `requestApproval` suspends a run by raising a
   LangGraph `interrupt()`, which exists only inside a graph run. No graph, no
   interrupt, no approval channel, therefore nothing that writes can be exposed.
3. **The root is pinned at launch**, never read from a tool argument. That is
   why `run_integrity_check` has an empty schema: accepting a path would reopen
   the traversal surface ADR-011 closed and hand it to a remote caller.
4. **`stdout` belongs to the protocol.** See below.
5. **The index must be warm**, and its state is reported rather than assumed.

## `stdout` discipline — read this before adding anything

Over stdio, JSON-RPC travels on `stdout`. **One stray byte corrupts the
connection**, before the handshake completes, silently from the client's side.

`start-mcp-server.ts` redirects the diagnostic sink to `stderr` on its first
line, so `log.*` in `src/core/tools/utils/logger.ts` and the RAG subsystem's
output are safe. `jsonrpc-stdio.transport.ts` is the only component permitted to
write to `stdout`.

Two real leaks were found by the purity check rather than by reading code:

- `src/core/rag/indexer.ts` wrote a raw `.` per batch while warming the index.
- `src/core/llm/provider.ts` called `dotenv.config` without `quiet: true` at
  module import; dotenv v17 prints a banner and a usage tip to `stdout`.

Neither was visible to a `console.log` grep. If you add anything to this path,
run the purity spec in `jsonrpc-stdio.transport.spec.ts` — it asserts that every
line on `stdout` parses as JSON-RPC 2.0.

**Still latent:** `src/core/interaction/infrastructure/chalk-logger.adapter.ts`
writes all five levels to `stdout` and does not go through the sink. It is not
on this path today because nothing here constructs an `InteractionService`.
Wiring interaction into MCP mode would reintroduce the defect.

## A launch flag must be pinned, not passed

`--embeddings` reached the availability probe and the indexer and **not the
query**, because `askCodebaseTool` builds `new RetrieverService()` with no
argument — it is a LangChain tool body and cannot see what the CLI parsed. The
query silently resolved to the project default while the provenance header named
the flag's provider: a correct answer from one provider, labelled as another.

`startMcpServer` now calls `pinEmbeddingsProvider` before anything can construct
a retriever, the same way it pins the runtime root, and provenance is read at
call time from the index stamp rather than from the launch selection. Recorded in
[ADR-025 amendment 2](../../../docs/adr/ADR-025-embeddings-are-chosen-not-assumed.md).

**The general rule for this directory:** anything chosen at launch has to reach
code that takes no parameters. Passing it down does not work, because the tool
bodies are not ours to give parameters to. Pin it.

## The DTO boundary is not optional

Umbra's tools return strings written for **Umbra's own prompt**: `❌ DENIED: …`,
`❌ APPROVAL_REQUIRED: …`, and `💡 AGENT HINT: … run: read_file("…")`. The system
prompt that gives that vocabulary meaning is not present in a foreign client, so
a foreign model reads `run: read_file(...)` as an instruction to call a tool this
server does not publish.

`dto-mapper.ts` translates the refusals and strips the hints, on an allowlist
basis — the same posture as `toSafeEvent` in `ai-agent-http.module.ts`, where an
unrecognised event is dropped rather than forwarded and hoped for.

## Why there is no MCP SDK dependency

`@modelcontextprotocol/sdk@1.30.0` is `"type": "module"` and this project
compiles to CommonJS, which is also why `chalk` is pinned to `^4`. It also pulls
in `express`, `hono`, `jose`, `cors`, `ajv` and `eventsource`. The wire format is
newline-delimited JSON-RPC 2.0; owning ~200 lines of it is cheaper than owning
the packaging problem, and it is what gives absolute control over `stdout`.

## Files

| File | Role |
|---|---|
| `mcp.contracts.ts` | DTOs and closed unions. Imports nothing from `src/core/` |
| `jsonrpc-stdio.transport.ts` | The wire. The only writer to `stdout` |
| `umbra-mcp-server.ts` | Dispatch for the nine supported methods |
| `tool-catalog.ts` | The four tools as MCP descriptors, schemas written by hand |
| `resource-catalog.ts` | `umbra://adr-index`, `umbra://index-status` |
| `prompt-catalog.ts` | `skills/*.md` as prompts |
| `dto-mapper.ts` | The boundary: refusals translated, hints stripped, provenance added |
| `start-mcp-server.ts` | Startup, in the one order that works |

## Known gap

ADR-024's table lists a README index resource. `list_readmes` is recorded as
Accepted in [ADR-003](../../../docs/adr/ADR-003-on-demand-readme-index.md) but
**has no implementation** in `src/` — no tool, no index builder, no cache writer.
It is therefore not published, because publishing a resource this repository
cannot produce is the same defect as advertising a tool that cannot answer.
ADR-003 is owed an amendment.
