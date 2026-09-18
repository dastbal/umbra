# `src/presentation/mcp/` — Umbra as a read-only MCP server

Umbra's third presentation adapter, beside `cli/` and `http/`. It publishes what
Umbra knows about **one** repository to any Model Context Protocol client —
Claude Code, Codex, Cursor, Gemini CLI — over stdio.

Decided in [ADR-024](../../../docs/adr/ADR-024-umbra-as-a-read-only-mcp-server.md)
and extended by [ADR-036](../../../docs/adr/ADR-036-persistent-read-only-mcp-conversations.md).
Pluggable embeddings, which is what lets `ask_codebase` be published without a
Google account, are [ADR-025](../../../docs/adr/ADR-025-embeddings-are-chosen-not-assumed.md).

## Running it

```bash
umbra mcp --root /path/to/repo
# Global client registration uses this safe root-resolution mode:
umbra mcp --auto-root
```

| Flag | Meaning |
|---|---|
| `--root <path>` | Explicit repository to serve. Fixed for the process; no tool argument can change it |
| `--auto-root` | Use Claude's declared project, a validated client working directory, or exactly one MCP `file:` root after handshake |
| `--embeddings <vertex\|ollama>` | Embedding provider for semantic search. Default: whatever `.umbra/agent.config.json` says, else `ollama` |
| `--no-index` | Skip warming the semantic index at launch |

Registering it with a client is one entry pointing at the binary with those
arguments. Removing it deletes that client entry; any root already activated
keeps only its local, gitignored `.umbra/` cache and `.gitignore` rule.

## What it publishes

| Kind | Name | Cost |
|---|---|---|
| Tool | `list_adrs` | free |
| Tool | `query_dependency_graph` | free |
| Tool | `run_integrity_check` | free (runs `tsc --noEmit`) |
| Tool | `ask_codebase` | embeds the query after durable vector coverage is proven |
| Tool | `get_index_status` | free lifecycle and durable coverage evidence |
| Tool | `continue_conversation` | configured chat provider; read-only persistent advisor |
| Resource | `umbra://adr-index` | free |
| Resource | `umbra://index-status` | free |
| Prompt | one per `skills/*.md` | free |

The catalog is fixed before handshake. `ask_codebase` is therefore always
advertised, but returns a typed retryable status until `get_index_status` shows
durable coverage. This avoids a stale client tool list while never pretending a
partial index can answer.

## The five constraints this module exists to honour

1. **One constrained chat-model exception.** `continue_conversation` runs only
   the `mcp-advisor`, a persisted advisory graph with read capabilities. The
   deterministic evidence tools remain model-free; no MCP path gains a writer,
   shell, approval, or caller-selected root.
2. **No write tools.** No MCP tool can write, request approval, or choose a
   filesystem path. After a trusted root is accepted, startup may create its
   local index state and protect it in `.gitignore`; that activation is not
   client-directed and is outside the published tool surface.
3. **The root is pinned before any root-bound tool runs**, never read from a tool argument. That is
   why `run_integrity_check` has an empty schema: accepting a path would reopen
   the traversal surface ADR-011 closed and hand it to a remote caller.
4. **`stdout` belongs to the protocol.** See below.
5. **Semantic results require durable coverage.** The MCP handshake and status
   tool never wait for warm-up; only `ask_codebase` is retryable until coverage
   is proven.

## `stdout` discipline — read this before adding anything

Over stdio, JSON-RPC travels on `stdout`. **One stray byte corrupts the
connection**, before the handshake completes, silently from the client's side.

`start-mcp-server.ts` redirects the diagnostic sink to `stderr` on its first
line, so `log.*` in `src/core/tools/utils/logger.ts` and the RAG subsystem's
output are safe. The SDK's `StdioServerTransport` is the only component
permitted to write to `stdout`, and it is handed the stream only after every
startup diagnostic has already gone to `stderr`.

Two real leaks were found by the purity check rather than by reading code:

- `src/core/rag/indexer.ts` wrote a raw `.` per batch while warming the index.
- `src/core/llm/provider.ts` called `dotenv.config` without `quiet: true` at
  module import; dotenv v17 prints a banner and a usage tip to `stdout`.

Neither was visible to a `console.log` grep. If you add anything to this path,
run the purity spec in `sdk-server.spec.ts` — it asserts that every line on
`stdout` parses as JSON-RPC 2.0. It is carried over unchanged from the
hand-written transport: if the SDK speaks the same protocol, the same assertion
has to hold.

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

## The MCP SDK is a required runtime dependency

> **Corrected.** This section used to explain why there was *no* SDK
> dependency, on the premise that `@modelcontextprotocol/sdk` was ESM-only and
> unusable from this CommonJS project. That premise was false: its `exports` map
> carries a `require` condition and a full CJS build, the same dual layout
> `@langchain/core` already uses here. The conclusion was reached by reading
> `type: "module"` at the top of the manifest and stopping there. The root cause
> was `moduleResolution: "node"` in `tsconfig.json` — Node 10 resolution, which
> does not read `exports` maps at all.

The SDK owns the protocol: JSON-RPC framing, ids, notifications, error codes,
capability advertisement, the handshake, and the JSON Schema it derives from the
zod shapes in `tool-catalog.ts`. About 400 lines of hand-written protocol are
gone.

It is declared as an exact production dependency. A global `umbra mcp` command
must work before a client allows its first handshake, so an optional peer is not
an acceptable installation contract. `sdk-loader.ts` still requires its small
stdio server surface lazily and reports a concrete Umbra reinstall command if a
package installation is damaged.

```bash
npm i -g @dastbal/umbra
```

### Three behaviours that changed with the swap

Verified by running the round-1 handshake script unmodified. Recorded because
"transparent replacement" was the goal and these are the places it is not:

| | Hand-written | SDK |
|---|---|---|
| A malformed line | answered with JSON-RPC `-32700` and stayed connected | silently dropped, no response |
| Response order | strictly in request order | concurrent; ids may return out of order (legal, and faster) |
| Unknown tool | *"Unknown tool X. This server publishes: …"* | `MCP error -32602: Tool X not found` |

None is a defect. The first is a small loss of diagnosability, the second is an
improvement, the third trades a helpful message for a standard one.

## Files

| File | Role |
|---|---|
| `mcp.contracts.ts` | DTOs and closed unions. Imports nothing from `src/core/` |
| `sdk-loader.ts` | Lazy `require` of the required SDK, plus the damaged-install hint |
| `sdk-server.ts` | Registers the catalogs on the SDK's `McpServer` |
| `tool-catalog.ts` | The five stable tools, with zod shapes the SDK turns into JSON Schema |
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
