# ADR-024 — Umbra as a read-only MCP server

| | |
|---|---|
| **Category** | Architecture · Packaging · Integration |
| **Author** | David Balladares (decision) · Claude (record) |
| **Date** | 2026-09-02 |
| **Status** | ✅ **Accepted** — amended 16× 2026-09-04 → 2026-09-10. Amendment 1 was **wrong** and is corrected in amendment 6 |

---

## Context

Umbra holds knowledge about a repository that no other tool on this machine has:
a semantic index of the code, a bounded ADR catalog (ADR-004), an AST-level
dependency graph, and a type-level integrity check. Today that knowledge is
reachable **only from inside Umbra's own agent loop**.

Two facts turn that from a design into a limitation.

**1. Umbra is hermetic.** `CAPABILITY_REGISTRY` in `src/core/agent/agent-kernel.ts`
grants twelve tools to a role. None of them reaches a database, a ticket, a
production log, a browser, or the network. `executeCommandTool` in
`src/core/tools/system-tools.ts` exists but is referenced only from
`src/core/agent/graph/coder.graph.ts` — the legacy graph ADR-011 deprecated — and
is absent from `CAPABILITY_REGISTRY`, so under `umbra deep` there is no shell.
This containment is deliberate and is not being reversed here.

**2. Four agents keep four different views of the same code.** The operator runs
Claude Code, Codex, Antigravity and Gemini CLI against the same repositories.
Their *instructions* were unified into one global constitution on 2026-08-21;
their *knowledge of the codebase* never was. Each rebuilds it with its own grep,
and each reaches its own conclusions.

`docs/improvements-analysis.md` §1 already proposed the opposite direction —
Umbra as an MCP **client**, consuming third-party servers to widen what the agent
can see. That idea is not dead; it was evaluated against this one and lost for
v1. The Trade-offs table records why.

---

## Decision

Expose Umbra's read-only knowledge over the Model Context Protocol as a **third
presentation adapter**, beside the two that already exist (`src/presentation/cli/`,
`src/presentation/http/`). **The domain does not move.**

In MCP server mode Umbra has **no model inside it**. It does not reason, does not
build prompts, does not call a provider, and runs no agent loop. It receives a
request and answers it by executing deterministic code. Everything ADR-006,
ADR-015, ADR-016 and ADR-019 govern — streaming, provider auth, reasoning
vocabulary, turn budget — is out of scope for this mode by construction.

### What is published

| MCP primitive | Umbra asset | Symbol |
|---|---|---|
| Tool | semantic code search | `askCodebaseTool` in `src/core/tools/rag-tools.ts` |
| Tool | bounded ADR catalog | `listAdrsTool` in `src/core/tools/system-tools.ts` |
| Tool | AST dependency graph | `queryDependencyGraphTool` in `src/core/tools/analysis-tools.ts` |
| Tool | type-level integrity | `integrityCheckTool` in `src/core/tools/testing-tools.ts` |
| Resource | ADR index, README index | the cached catalogs in `.umbra/` (ADR-003, ADR-004) |
| Prompt | the shipped skills | `skills/*.md`, already in `package.json#files` (ADR-012) |

### What is deliberately **not** published in v1

`safeWriteFileTool`, `deleteFileTool`, `executeTestsTool`, `executeCommandTool`,
and the delegation tools. Not withheld out of caution alone — see constraint 2,
which makes writes technically unavailable in this mode.

### The five constraints that are part of the decision

1. **No model.** The server never instantiates a chat model. The one exception is
   an embedding call inside `RetrieverService#query` — see Negative consequences.
2. **No writes.** `requestApproval` in `src/core/tools/utils/approval.ts` suspends
   by raising a LangGraph `interrupt()`, which only exists **inside a graph run**.
   MCP server mode has no graph, therefore no interrupt, therefore no human
   approval channel, therefore nothing that writes may be exposed. The future
   bridge is MCP *elicitation*, already identified as the same pattern in
   `docs/deferred-work.md` (§ *`ask_human` with multiple choice*). Separate work.
3. **The root is pinned at launch and never read from a tool argument.** Accepting
   a root from an argument would reopen the whole path-traversal surface of
   ADR-011 and hand it to a remote caller. This is the single security decision
   the mode depends on.
4. **`stdout` belongs to the protocol.** Over stdio, JSON-RPC travels on stdout.
   Any log written there corrupts the connection.
5. **The index must be warm.** `askCodebaseTool` reads from SQLite via `AgentDB`;
   with no index it returns nothing, silently. The server indexes at launch and
   reports a partial index rather than pretending, per ADR-017.

### Entry point

A subcommand of the existing binary — `umbra mcp --root <path>` — registered in
`src/bin/cli.ts` alongside `deep`, `orchestrate`, `analyze` and `init`.
**ADR-010's single-binary decision is preserved, not contradicted:** this is one
more `program.command()`, not a second executable.

```mermaid
graph LR
    subgraph today["Today — Umbra hosts the model"]
        Op([Operator]) --> CLI[umbra deep]
        CLI --> Agent[DeepAgent]
        Agent --> Provider[(Vertex / Anthropic)]
        Agent --> Tools[12 capability tools]
        Tools --> Repo[(repository)]
    end
    subgraph proposed["Proposed — Umbra answers, the client thinks"]
        Clients([Claude Code / Codex / Cursor / Gemini CLI]) -->|stdio JSON-RPC| Srv[umbra mcp]
        Srv --> RO[4 read-only tools + resources + prompts]
        RO --> Repo2[(repository)]
    end
```

---

## Trade-offs

Three directions were really on the table.

| Option | Pros | Cons | Decision |
|---|---|---|---|
| **A. MCP client first** (`docs/improvements-analysis.md` §1) — Umbra consumes third-party servers | Widens what the agent can *see*: DB schema, tickets, PRs, production logs | Imports the whole trust problem: a tool description is prompt text the model obeys, so a third party writes into Umbra's context. Also needs the security gate moved to middleware first, because the policy currently lives *inside* each tool body (`authorizeFileAction`, `requestApproval`) and a client-generated tool body calls none of it | ❌ Deferred. Not rejected as an idea — rejected as the *first* step |
| **B. MCP server, read-only** | Reuses the sound half of the codebase and avoids the fragile half. **No trust problem at all: Umbra writes its own tool descriptions.** No credentials to hand out, no third-party processes to supervise, reversible by deleting one config line | Publishes no new capability to Umbra itself — the operator's own agent gains nothing directly | ✅ **Chosen** |
| **C. MCP server with writes** | Would let a foreign client use Umbra to *change* code | Impossible in v1 without inventing a second approval channel, which constraint 2 explains. Also grants a remote caller write access to the repository, a much larger decision than this record | ❌ Rejected for v1 |

Option B also matches an existing precedent rather than inventing one: ADR-022
decided that explicitly external roles are **read-only advisors in v1**. Same
boundary, same reasoning, one layer out.

---

## DDD layer mapping

| Layer | Component | Impact |
|---|---|---|
| Domain | — | **Unchanged.** That is the point of the decision |
| Application | — | **Unchanged.** Existing tools are reused as they are |
| Infrastructure | `src/core/tools/utils/logger.ts` — `log` | Must write to `stderr` in MCP mode (constraint 4) |
| Infrastructure | `src/core/rag/retriever.ts` — `RetrieverService` | Its own `console.log` calls must move off stdout |
| Presentation | **new** `src/presentation/mcp/` | The MCP server: transport, capability advertisement, DTO boundary |
| Presentation | `src/bin/cli.ts` | Registers the `mcp` subcommand |

### The DTO boundary is not optional

Umbra's tools return strings shaped for **Umbra's own prompt**:
`formatAuthorizationFailure` in `src/core/tools/utils/authorize.ts` returns
`❌ DENIED: …`, and the system prompt that gives that vocabulary meaning
(`WRITER_PROTOCOL` in `src/core/agent/deep-agent-factory.ts`) will not be present
in a foreign client. A foreign model reads those strings without their context.

The rule is the one this project already follows everywhere else: **a presentation
layer returns DTOs, never internals.** New presentation, same law.

---

## Consequences

### Positive

- **One source of truth for four agents.** What the global constitution did for
  instructions, this does for knowledge of the code.
- **The cheapest possible surface.** No model, no credentials to distribute, no
  writes, no provider code paths. The whole security question reduces to
  constraint 3.
- **`skills/*.md` stop being Umbra-only.** As MCP prompts they become invocable by
  any client — one skill written once, four agents using it.
- **Adoption of `@dastbal/umbra` loses its main objection.** "Install a CLI and let
  an agent write to your repository" becomes "add one line, read-only".
- **Measured token economy.** Answering the three questions that produced this
  record took eleven tool calls to rediscover facts the repository already knows.
  Two MCP calls would have replaced most of them — and that saving repeats every
  session, for every agent.

### Neutral

- Umbra's own agent gains no new capability. This record widens who can *ask*, not
  what Umbra can *do*.
- MCP's `notifications/tools/list_changed` is not used: the published list is fixed
  at launch. A dynamic list would recreate the prompt/tool drift ADR-013
  documents, with an external process as the cause.
- MCP *sampling* (a server asking the client to run a model call) is advertised as
  unsupported. It would let a third party spend the client's budget on a prompt
  nobody audited.

### Negative — accepted honestly

- **`ask_codebase` is not free and needs Google credentials.** `RetrieverService#query`
  calls `embedQuery` on the model from `LLMProvider.getEmbeddingsModel`, which is
  `VertexAIEmbeddings` (`text-embedding-004`) and runs
  `LLMProvider.ensureVertexCredentials` first. So three of the four published
  tools cost nothing, and the fourth costs cents per query **and cannot run at all
  without ADC**. This directly limits the adoption argument above.
  → **Dependency:** the deferred item *"Umbra should not require Google to run at
  all"* in `docs/deferred-work.md`. Local embeddings (the Ollama stack is already a
  dependency) would make all four tools free and credential-free. This record is
  the use case that makes that item worth doing.
- **Retrieval is a full scan.** `RetrieverService#query` runs
  `SELECT * FROM code_chunks` and computes `cosineSimilarity` in JS over every row.
  Acceptable for one operator; it is the bottleneck the moment a server answers
  several clients over a large repository.
- **Two logging paths must be corrected before stdio works at all** (constraint 4).
- **A third presentation layer is a third thing to keep in sync.** ADR-012's six
  amendments are the standing evidence of what CLI drift costs.

---

## Verification Evidence

> **Amended 2026-09-02.** The paragraph below was accurate when written and is
> now stale in one respect: an implementation exists. It is kept because the
> constraint evidence it introduces is still what the design rests on. The
> implementation evidence is added in a second section further down, and the
> *Not verified* list is amended rather than rewritten.

Everything below was run on 2026-09-02 in this repository. **It verifies the
constraints this record depends on — it does not verify an implementation, because
none exists yet.**

**The tools a role can actually receive** — read `CAPABILITY_REGISTRY` in
`src/core/agent/agent-kernel.ts`: eleven capabilities resolving twelve tools, none
of them network, database, or shell.

**No shell under `umbra deep`:**

```
$ grep -rn "executeCommandTool" src --include=*.ts | grep -v "^src/core/tools/"
src/core/agent/graph/coder.graph.ts:10:  executeCommandTool, askHumanTool, deleteFileTool
src/core/agent/graph/coder.graph.ts:27:  const dangerousCodingTools = [deleteFileTool, executeCommandTool, askHumanTool];

$ grep -n "executeCommandTool" src/core/agent/agent-kernel.ts
(no output)
```

**`stdout` is contended, and the blast radius is small.** 125 `console.log` calls
in `src` (excluding specs), but only ~21 sit in the code paths a read-only server
would execute; the remaining ~104 are CLI presentation, which this mode never runs:

```
$ grep -rn "console\.log" src --include=*.ts | grep -v spec | awk -F: '{print $1}' | sort | uniq -c | sort -rn
     53 src/presentation/cli/model-menu.ts          <- not in MCP path
     33 src/bin/cli.ts                              <- not in MCP path
     16 src/presentation/cli/chat-session.ts        <- not in MCP path
      6 src/core/interaction/infrastructure/chalk-logger.adapter.ts
      5 src/core/tools/utils/logger.ts              <- used by every tool
      5 src/core/rag/retriever.ts
      4 src/core/rag/indexer.ts
      ...
```

`log` in `src/core/tools/utils/logger.ts` writes all five of its levels —
including `error` — with `console.log`, i.e. to stdout.

**The root is read from the process, inside a tool body.** `integrityCheckTool` in
`src/core/tools/testing-tools.ts` opens with `const rootDir = process.cwd();`.
A `--root` flag will not be honoured until that is injected rather than read — the
same one-value-one-constant lesson as ADR-018.

**`ask_codebase` spends and needs credentials.** `RetrieverService#query` in
`src/core/rag/retriever.ts` calls `embedQuery`; `LLMProvider.getEmbeddingsModel`
in `src/core/llm/provider.ts` constructs `VertexAIEmbeddings` after
`ensureVertexCredentials`.

**The presentation-layer precedent is real.** `ls src/presentation/` returns
exactly `cli` and `http`, and `src/index.ts` exports `./presentation/http`
alongside the core.

**The skills already ship.** `package.json#files` is
`["dist", "skills/*.md", "README.md"]` (ADR-012).

### Not verified

- No MCP server, transport, or handshake has been written or run.
- The MCP SDK is not a dependency of this project yet.
- The latency and context cost of publishing four tools to a foreign client have
  not been measured.

> **Amended 2026-09-02.** The first two items are closed and the third stands.
>
> - The server, the transport and the handshake are written and were run; see
>   *Implementation evidence* below.
> - The MCP SDK is **still not a dependency, and now never will be** — see
>   amendment 1. The item is closed by a decision, not by an installation.
> - Latency and context cost are still unmeasured. `tools/list` returns four
>   descriptors totalling roughly 700 tokens of schema and description; what
>   that costs a client across a session has not been observed.
>
> One item is **added**: `ask_codebase` has never been answered by local
> embeddings, because `nomic-embed-text` is not installed on this machine. See
> ADR-025's own *Not verified*.

---

## Implementation evidence — added 2026-09-02

Run against the built output (`npm run build`, then `node dist/bin/cli.js`), with
a script that spawns the server, speaks JSON-RPC over the pipe, and separates
`stdout` from `stderr`.

**A real handshake, and the tools answered.** `initialize` →
`notifications/initialized` → `tools/list` → `prompts/list` → `resources/list` →
`resources/read` → four `tools/call` → `ping` → a deliberately malformed line:

```
id=1  -> initialize ok, protocol 2025-06-18, caps tools+resources+prompts
id=2  -> tools: ask_codebase, list_adrs, query_dependency_graph, run_integrity_check
id=3  -> prompts (13): analyze-codebase, create-ddd-module, … write-tests
id=4  -> resources: umbra://adr-index, umbra://index-status
id=6  -> tool ok: "ADR catalog (cached; 26 decisions): - ADR-001 — …"
id=7  -> tool ok: "DEPENDENCY GRAPH (INBOUND) for src/core/rag/retriever.ts: - [import] src\core\tools\rag-tools.ts"
id=8  -> TOOL ERROR: Unknown tool "safe_write_file". This server publishes: …
id=10 -> tool ok: "[embeddings: vertex/text-embedding-004 · 19 files indexed · indexed 2026-09-02T21:13:20.219Z] …"
id=null -> ERROR -32700: Invalid JSON.
```

The notification was correctly **not** answered. The malformed line produced a
parse error and the connection survived it. `safe_write_file` — a real Umbra
tool — is not reachable, which is constraint 2 holding in practice.

**`stdout` was not pure, and the purity check is what found it.** The first run
reported:

```
lines on stdout: 13
valid JSON-RPC : 11
NON-JSON-RPC   : 2
--- offending lines ---
"◇ injected env (0) from .env // tip: ⌘ suppress logs { quiet: true }"
"◇ injected env (0) from .env.development // tip: ⌘ enable debugging { debug: true }"
```

`src/core/llm/provider.ts:65-66` called `dotenv.config` **without `quiet: true`**
at module import, and dotenv v17 prints a banner plus a usage tip to `stdout`.
`src/bin/cli.ts` had always passed `quiet` on its own two calls; these two, added
later and running at import time, did not. Fixed; the check now reports
`11 lines, 11 valid, 0 non-JSON-RPC`, and again with index warming enabled.

**The `process.stdout.write` leak this record's own evidence missed.**
`src/core/rag/indexer.ts:211` wrote a raw `.` per batch as progress — on the
exact path the server executes while warming the index at launch. The original
evidence above enumerated `console.log` sites and therefore could not see it.
Both leaks were found by machine, not by reading code, which is why the purity
assertion is now a spec rather than a one-off script.

**Diagnostics went to `stderr`, not nowhere.** With index warming on:

```
[umbra mcp] umbra mcp — serving C:\…\nestjs-ai-agent-lib
[umbra mcp] embeddings: vertex/text-embedding-004 (from config)
..
[umbra mcp] index ready
[umbra mcp] publishing 4 tools: ask_codebase, list_adrs, query_dependency_graph, run_integrity_check
⚙️  [SYS]: ADR catalog cached: 26 decisions
🔍 [RAG] Embedding Query: "where is the dependency graph queried?"...
```

Every one of those lines is on `stderr`, including the two progress dots.

**Conditional advertisement works, with a diagnosable reason.** Ollama was
running with four `gemma4` tags and no embedding model:

```
[umbra mcp] ask_codebase NOT published — Ollama is running but the model
            "nomic-embed-text" is not installed. Run: ollama pull nomic-embed-text
[umbra mcp] publishing 3 tools: list_adrs, query_dependency_graph, run_integrity_check
```

`tools/list` returned exactly three, and calling `ask_codebase` returned an error
naming what *is* published.

**No new dependencies.** `package.json` still declares 19 direct dependencies.

**The suite.** `685 passed, 5 skipped, 69 of 70 suites`, including 38 new
assertions. No existing spec was modified.

**A third presentation adapter exists.** `ls src/presentation/` now returns
`cli`, `http`, `mcp`.

---

## Amendments

### 1 — 2026-09-02 · The official MCP SDK is not used, and the transport is Umbra's own

> **This amendment was wrong. Corrected by amendment 6, the same day.** The
> premise below — that the SDK cannot be `require()`d from this project — is
> false, and the SDK is now used. The text is kept because the *dependency
> weight* half of the argument was sound and is what made the dependency
> optional rather than plain, and because the mistake itself is the point of
> amendment 6.

This record assumed an SDK and listed "the MCP SDK is not a dependency of this
project yet" as a gap to close. It is not a gap; it is a decision.

`@modelcontextprotocol/sdk@1.30.0` is `"type": "module"`. This project compiles
to CommonJS — `tsconfig.json` sets `"module": "CommonJS"` and `package.json`
declares no `"type"` — which is the same reason `chalk` is pinned to `^4`. The
SDK cannot be `require()`d from `dist/`. It also depends on `express`, `hono`,
`jose`, `cors`, `ajv`, `eventsource` and a dozen more: eighteen transitive
packages added to a library with nineteen direct dependencies, to serve nine
methods over a pipe.

MCP over stdio is newline-delimited JSON-RPC 2.0. What was actually required was
a line reader, `JSON.parse`, and a serializer — `jsonrpc-stdio.transport.ts`,
about 200 lines with no dependencies. Owning that is cheaper than owning the
packaging problem, and it is what gives the absolute control over `stdout` that
constraint 4 demands.

**The cost, recorded honestly:** the handshake is now Umbra's to maintain. If MCP
adds negotiation this server must implement it by hand. The mitigation is that
the surface is nine methods and the version advertised is this server's own,
never echoed back from the client, so the server can never claim support for a
revision nobody wrote.

### 2 — 2026-09-02 · `ask_codebase` is advertised conditionally, not unconditionally

The record published four tools unconditionally. It also recorded, as an accepted
negative consequence, that `ask_codebase` "cannot run at all without ADC".

Both cannot be true at once without reintroducing the ADR-013 defect: a tool
declared to a model that cannot answer. Worse here than in ADR-013, because the
tool list is fixed at launch and cannot be corrected mid-session.

So `probeEmbeddings` runs at startup — Vertex credentials, or Ollama reachable
**with the embedding model actually installed** — and `ask_codebase` is published
only when the answer is yes. When it is not, `stderr` states the reason and the
command that fixes it, and the other three tools are unaffected.

Reachability was deliberately not treated as availability. A daemon answering on
its port with the model absent would have produced exactly the failure this
amendment exists to prevent.

### 3 — 2026-09-02 · The README index resource is not published, and ADR-003 is owed an amendment

*What is published* lists "ADR index, README index — the cached catalogs in
`.umbra/` (ADR-003, ADR-004)". Only the ADR index exists.

`list_readmes`, the entire subject of
[ADR-003](./ADR-003-on-demand-readme-index.md) and recorded there as **Accepted**,
has no implementation in `src/`: no tool, no index builder, no cache writer.
Verified by grep across the tree.

It is therefore not published, because publishing a resource this repository
cannot produce is the same defect as advertising a tool that cannot answer. A
second resource was published in its place — `umbra://index-status`, the semantic
index's provenance — which is a real artifact.

**The disagreement is between the code and a record, so neither was silently
picked:** the code is authoritative for what the system does now, and ADR-003 is
owed an amendment saying whether `list_readmes` was reverted, never merged, or
lost. That amendment is not written here because it is not this record's to make.

### 4 — 2026-09-02 · The root is pinned in one constant, and three call sites now read it

Constraint 3 said the root must be pinned at launch and never read from a tool
argument. The evidence noted `integrityCheckTool` opening with
`const rootDir = process.cwd();` and predicted that "`--root` will not be honoured
until that is injected rather than read".

The prediction was right and incomplete. Three places read the working directory
on the published path, not one: `testing-tools.ts`, `system-tools.ts`, and —
the one that mattered most — `AgentDB.getInstance` in `src/core/state/db.ts`,
which fixes the workspace for the whole process on first use.

`src/core/config/runtime-root.ts` now holds `pinRuntimeRoot` / `runtimeRoot`,
defaulting to `process.cwd()` so no existing command changes behaviour, and
throwing on a conflicting re-pin rather than silently serving the wrong
repository. `run_integrity_check` keeps its empty schema, which is the point.

### 5 — 2026-09-02 · `query_dependency_graph` had no capability at all

The record published it as one of four tools. It was not in
`CAPABILITY_REGISTRY` — the file's own comment calls that registry "the single
source of truth for built-in capabilities and their concrete tools" — and no
capability resolved it. It was reachable only by direct import.

It is now registered as `read_dependency_graph`, risk `read`. Deliberately its
own capability rather than an addition to `search_codebase`, because that one
also grants `refreshIndexTool`, which writes.

---

## Related Files

- `src/core/agent/agent-kernel.ts` — `CAPABILITY_REGISTRY`, `resolveCapabilityTools`, `CapabilityRisk`, `KernelTool`
- `src/core/tools/rag-tools.ts` — `askCodebaseTool`, `refreshIndexTool`
- `src/core/tools/system-tools.ts` — `listAdrsTool`, `listFilesTool`, `executeCommandTool`
- `src/core/tools/analysis-tools.ts` — `analyzeCodeStructureTool`, `queryDependencyGraphTool`
- `src/core/tools/testing-tools.ts` — `integrityCheckTool` (reads `process.cwd()`), `executeTestsTool`
- `src/core/tools/utils/logger.ts` — `log` (all five levels write to stdout)
- `src/core/tools/utils/approval.ts` — `requestApproval`, `rethrowIfSuspension`
- `src/core/tools/utils/authorize.ts` — `formatAuthorizationFailure`, `evaluateFileAction`, `authorizeFileAction`
- `src/core/rag/retriever.ts` — `RetrieverService#query`, `RetrieverService#getContextForLLM`
- `src/core/rag/math.ts` — `cosineSimilarity`
- `src/core/rag/indexer.ts` — `IndexerService#indexProject`
- `src/core/state/db.ts` — `AgentDB`
- `src/core/llm/provider.ts` — `LLMProvider.getEmbeddingsModel`, `LLMProvider.ensureVertexCredentials`, `LLMProvider.vertexProjectField`
- `src/core/agent/deep-agent-factory.ts` — `WRITER_PROTOCOL`, `DeepAgentFactory.create`
- `src/core/agent/graph/coder.graph.ts` — `dangerousCodingTools` (legacy path, ADR-011)
- `src/bin/cli.ts` — the `program.command()` registrations the `mcp` subcommand joins
- `src/index.ts` — the public surface a new presentation adapter would extend
- `src/presentation/cli/`, `src/presentation/http/` — the two existing presentation adapters
- `package.json` — `files` (ships `skills/*.md`), `bin.umbra` (ADR-010)
- `docs/improvements-analysis.md` — §1, the MCP-client proposal this record defers
- `docs/deferred-work.md` — *"Umbra should not require Google to run at all"* (the local-embeddings dependency); *"`ask_human` with multiple choice"* (the elicitation mechanism to reuse)

---

### 6 — 2026-09-02 · The official SDK is adopted, because amendment 1's premise was false

Amendment 1 rejected `@modelcontextprotocol/sdk` as unusable from this CommonJS
project, on the grounds that it is `"type": "module"`. **That is not what
`type` means when a package ships a dual `exports` map**, and this one does:

```
exports['./server'] = { import: './dist/esm/server/index.js',
                        require: './dist/cjs/server/index.js' }

$ node -e "require('@modelcontextprotocol/sdk/server/mcp.js')"
McpServer: function     → REQUIRE FROM COMMONJS: WORKS
```

It is the same layout `@langchain/core` uses, which this project has always
consumed without trouble — eleven of its nineteen dependencies carry an ESM
manifest. A probe file compiled under the project's own `tsconfig.json` reported
only the deliberate type error placed in it, never a resolution failure.

**The root cause was in this repository, not in the SDK.** `tsconfig.json` had
`moduleResolution: "node"` — Node 10 resolution, which predates the `exports`
field and does not read it. Under that lens the SDK's `require` path does not
exist. The conclusion was drawn from reading `type: "module"` at the top of the
manifest and stopping there, and the tooling agreed because it was looking the
same wrong way. Fixed: the project now resolves at `Node16`, which immediately
surfaced a real portability bug in an unrelated dependency
([ADR-026](./ADR-026-vectors-are-numbers-and-the-database-can-count.md)).

**What survived from amendment 1** is the dependency-weight argument, measured:
5.7 MB for the SDK plus ~6.9 MB of transitive packages — `hono`, `ajv`, `jose`,
`express`, `cors`, `eventsource`. That is why the SDK is an **optional peer
dependency** rather than a plain one, so a consumer who installs
`@dastbal/umbra` for its NestJS module never downloads a protocol they do not
speak. `peerDependenciesMeta.optional`, not `optionalDependencies`, because the
latter installs.

`jsonrpc-stdio.transport.ts` and `umbra-mcp-server.ts` are retired — about 400
lines of framing, ids, notifications and error codes. The hand-written JSON
Schema in `tool-catalog.ts` is replaced by zod raw shapes the SDK converts
itself.

**What stayed ours**, because a protocol library cannot know it: the DTO
boundary, which tools exist at all, the descriptions rewritten for a foreign
reader, retrieval provenance, and the startup order with its pinned root and
pinned embedding provider.

**Three behaviours changed**, found by running the round-1 handshake script
unmodified and recorded rather than glossed:

| | Hand-written | SDK |
|---|---|---|
| A malformed line | answered `-32700`, stayed connected | dropped silently |
| Response order | strictly in request order | concurrent; ids may return out of order |
| Unknown tool | named what *is* published | `MCP error -32602: Tool X not found` |

The stdout purity assertion was carried into `sdk-server.spec.ts` verbatim and
still passes. It is the test that found both real leaks in the original
implementation, and if the SDK speaks the same protocol the same assertion has
to hold.

**What this unblocks**, still unbuilt: the HTTP/streamable transport (several
clients, remote), and **elicitation** — the channel constraint 2 named as the
prerequisite for anything that writes.

---

### 7 — 2026-09-03 · MCP onboarding is explicit, additive, and never an install hook

The first public MCP instructions required a developer to copy a JSON block into
`.mcp.json`. That is a small step, but it is easy to mistype and discourages
adoption of the read-only server this record introduced. The alternative proposed
was a package `postinstall` hook which would create or modify the file whenever
`npm install` runs.

**The hook is rejected.** A dependency installation must not silently change a
consumer repository's tool configuration or register a command a client might
later launch. This is not a distinction of convenience: the root pinning rule in
this decision means the generated entry grants access to a specific repository.
The operator must see and choose that change.

`umbra init` now asks, defaulting to **No**, whether to enable the project as a
read-only MCP server. On approval,
`ensureUmbraMcpConfiguration` in `src/core/config/mcp-config.ts` creates or
updates only `mcpServers.umbra`. It preserves other server entries, rejects
malformed JSON or a non-object `mcpServers` without writing, and pins `--root`
to the resolved current project directory. Re-running it is idempotent.

The generated absolute path is intentionally local. A team that wants a
portable, committed Claude Code entry continues to author it deliberately with
`${CLAUDE_PROJECT_DIR}`; an installer cannot know which client or substitution
syntax a team has chosen.

### Verification evidence

- `mcp-config.spec.ts` — 5 tests passed: creation, preserving another server,
  updating a stale Umbra entry, idempotence, and no overwrite of invalid JSON.
- `node node_modules/typescript/bin/tsc --noEmit --pretty false` — passed.
- `node node_modules/typescript/bin/tsc -p tsconfig.build.json` — passed;
  `npm run build` could not start on this Windows machine because the global npm
  installation is missing `npm-cli.js`.

### Related files added by this amendment

- `src/core/config/mcp-config.ts` — `ensureUmbraMcpConfiguration`.
- `src/core/config/mcp-config.spec.ts` — MCP configuration preservation and
  failure-boundary tests.
- `src/bin/cli.ts` — `init`'s explicit MCP opt-in.
- `README.md` — generated local configuration and portable team configuration.
- `src/core/config/mcp-config.ts` — `detectSupportedMcpClients`, `configureCodexMcp`, `ensureUmbraMcpConfiguration`.
- `src/bin/cli.ts` — `setupMcpClient`, `setupDetectedMcpClients`.

### 8 — 2026-09-04 · Client adapters are explicit; the server remains portable

Umbra serves standard stdio MCP, but client configuration formats are not a
protocol feature. `umbra setup mcp` therefore detects and offers only verified
adapters. `setup codex` invokes `codex mcp add umbra -- npx -y @dastbal/umbra
mcp --root <absolute-root>` and verifies it with `codex mcp get umbra`; `setup
claude` preserves the existing additive `.mcp.json` behavior. Both show the
pinned root and require a default-No confirmation. Unknown clients receive a
copyable standard definition instead of an unsafe guessed write.

The normal command does not include `--no-index`: the server warms its one
pinned root at startup. That preserves the original warm-index constraint while
keeping `--no-index` available only for deliberate diagnostics.

### 9 — 2026-09-04 · One user-scoped registration activates one local index per open project

The project-pinned adapter in amendment 8 was safe, but it made a developer
repeat setup for every repository. That is friction without an architectural
benefit: `.umbra/` is already root-bound local state under ADR-018 and ADR-030,
and an MCP process already exists for the lifetime of one client session.

`umbra setup mcp`, `umbra setup codex`, and `umbra setup claude` now register a
user-scoped command ending in `umbra mcp --auto-root`. It contains no saved
project path. At process startup, `resolveMcpProjectRoot` in
`src/presentation/mcp/project-root.ts` selects Claude Code's
`CLAUDE_PROJECT_DIR` when present; otherwise it validates the server process
working directory. The selected directory must exist and look like an
Umbra-compatible project (`package.json`, `tsconfig.json`, `.git`, `src`, or an
Umbra/workspace declaration), is canonicalised through `realpath`, and is then
pinned by `startMcpServer` before any database, provider, or tool catalog is
created.

This is **not** a root argument exposed to MCP. A caller cannot switch projects
through a tool or through natural-language instructions. If the client provides
no valid project context, the server refuses to start and names the recovery:
open the client from the repository, then reconnect. That is intentionally
better than creating `.umbra/` beneath a home directory or a client installation
directory.

Claude Code's official user scope is configured and verified through `claude
mcp add --scope user` / `claude mcp get`; on native Windows the adapter uses the
documented `cmd /c npx` wrapper. Codex continues to use `codex mcp add` / `codex
mcp get`; it launches from its active project working directory. A deliberate
project-scoped entry may still use the existing explicit `--root <path>` form.

### Verification evidence

- `project-root.spec.ts` covers Claude precedence, working-directory launch,
  invalid Claude context, and ambiguous-directory rejection.
- `mcp-config.spec.ts` covers the global stdio definition and the Windows Claude
  wrapper in addition to the pre-existing project-entry preservation cases.
- Focused MCP suites: 20 tests passed. Full suite: 86 passed suites, 783 passed
  tests, with one pre-existing skipped suite and five skipped tests.
- `node node_modules/typescript/bin/tsc --noEmit --pretty false` and
  `node node_modules/typescript/bin/tsc -p tsconfig.build.json --pretty false`
  passed. A built `mcp --auto-root` launch from `C:\Windows` refused before
  startup and named the required project markers.

### Related files added by this amendment

- `src/presentation/mcp/project-root.ts` — `resolveMcpProjectRoot` and project-marker validation.
- `src/presentation/mcp/project-root.spec.ts` — trusted root resolution regressions.
- `src/core/config/mcp-config.ts` — global server definition and verified Codex/Claude adapters.
- `src/core/config/mcp-config.spec.ts` — global configuration command shapes.
- `src/bin/cli.ts` — `mcp --auto-root` and global setup commands.
- `README.md` — one-time global installation and per-project index lifecycle.

---

## Next step, if this is accepted

The first move is **not** writing the server. It is deciding whether local
embeddings land first, because that answers whether `ask_codebase` can be
published to a user who has no Google account — and that answer changes what v1
is worth.

> **Answered 2026-09-02.** Local embeddings landed first, as this section
> proposed, and are recorded in
> [ADR-025](./ADR-025-embeddings-are-chosen-not-assumed.md): a provider port,
> one vector column per provider, and coexistence rather than migration, so
> switching is reversible and the pre-existing index needed no reindex.
>
> The answer to "what is v1 worth" turned out to be conditional rather than
> binary, and amendment 2 records the shape it took: `ask_codebase` is published
> when embeddings are available and withheld with a reason when they are not.
> Three tools are free and credential-free either way.

---

### 10 — 2026-09-06 · A global MCP command has a self-contained runtime

Amendment 6's optional-peer decision is superseded **for the published MCP
adapter**. The measured package cost remains real, but an optional peer makes a
clean `@dastbal/umbra` installation capable of accepting `umbra mcp` and then
failing before its first MCP response. That failure is especially harmful for a
user-scoped registration because the client has no project-local dependency
step in which to repair it.

`@modelcontextprotocol/sdk` is therefore a pinned production dependency in
`package.json`, and the recovery message tells an operator to reinstall Umbra,
not to assemble a second package manually. The SDK is still loaded lazily from
its server subpaths so the adapter does not load its HTTP surface during a stdio
startup.

The user-scoped configuration emitted by
`buildGlobalUmbraMcpServer` now runs `umbra mcp --auto-root`, not `npx`. The
one-time documented flow is `npm install -g @dastbal/umbra` followed by
`umbra setup mcp`, `umbra setup codex`, or `umbra setup claude`. This makes the
server executable available before the client starts its MCP grace window.
An explicit `npx ... init` remains a manual way to invoke the CLI, but accepting
its optional MCP prompt follows this same user-scoped adapter flow. It does not
write a project-local `.mcp.json`; no install hook or consumer configuration
write was introduced.

### Verification evidence

- `corepack npm@10.8.2 install --package-lock-only --ignore-scripts` completed
  successfully and regenerated production dependency flags for the SDK tree.
- `src/core/config/mcp-config.spec.ts` and
  `src/presentation/mcp/sdk-server.spec.ts` — 16 tests passed.
- `node node_modules/typescript/bin/tsc --noEmit --pretty false` — passed.
- Tarball and clean-consumer smoke testing remain an explicit final release
  gate; they are not claimed by this amendment.

### Related files added by this amendment

- `package.json` — required `@modelcontextprotocol/sdk` runtime dependency.
- `package-lock.json` — production dependency closure for the SDK.
- `src/core/config/mcp-config.ts` — `buildGlobalUmbraMcpServer` and
  `globalClaudeMcpCommand`.
- `src/core/config/mcp-config.spec.ts` — global executable command contracts.
- `src/presentation/mcp/sdk-loader.ts` — `MCP_SDK_INSTALL_HINT`.
- `src/presentation/mcp/sdk-server.spec.ts` — damaged-installation recovery
  contract.
- `src/presentation/mcp/start-mcp-server.ts` — required-runtime startup
  diagnostic.
>
> **What is still open**, and is now the next step:
>
> 1. **Install `nomic-embed-text` and answer one `ask_codebase` call through
>    it.** Every component is exercised except the local embedding call itself.
>    Until that runs, "Umbra does not require Google" is designed, not proven.
> 2. **Register the server in the four clients and measure what `tools/list`
>    costs per session.** The token economy argument in *Positive* is still an
>    estimate.
> 3. **`ask_human` as MCP elicitation** — constraint 2's stated future bridge,
>    and the prerequisite for anything that writes. Unchanged and unstarted.

---

### 11 — 2026-09-06 · Automatic activation has a stricter project boundary

`resolveMcpProjectRoot` now accepts only durable project declarations:
`package.json`, `tsconfig.json`, `pnpm-workspace.yaml`, `umbra.json`, or a Git
directory/worktree marker. A bare `src` directory is not a project declaration
and is no longer sufficient. The exact home directory and the system temporary
directory are refused even if a marker happens to exist there.

After this validation, `activateMcpProjectRoot` first ensures the consumer's
`.gitignore` covers `.umbra/`; only then does it create the root-owned state
directory. If that ignore guarantee cannot be established, MCP startup fails
without creating a new unignored workspace. This is an explicit automatic
activation step, not an install hook and not a write initiated by an MCP tool.

### Verification evidence

- `project-root.spec.ts` and `agent-state-ignore.spec.ts` — 20 tests passed,
  including a `src`-only directory, Git worktree marker, blocked launch root,
  first activation, and idempotent activation.
- `mcp-config.spec.ts` and `sdk-server.spec.ts` — 16 regression tests passed.
- `node node_modules/typescript/bin/tsc --noEmit --pretty false` — passed.

### Related files added by this amendment

- `src/presentation/mcp/project-root.ts` — `resolveMcpProjectRoot` and
  `activateMcpProjectRoot`.
- `src/presentation/mcp/project-root.spec.ts` — launch-boundary and activation
  regressions.
- `src/presentation/mcp/start-mcp-server.ts` — activation before MCP state is
  opened.
- `src/core/config/workspace-scaffold.ts` — `ensureAgentStateIgnored` reused
  as the preservation boundary.

---

### 12 — 2026-09-06 · The MCP handshake precedes provider work

The MCP catalog is fixed and connected before Umbra probes an embedding
provider or begins indexing. A slow Ollama model can therefore never consume a
client's startup window. The five published tools are stable: `ask_codebase`,
`get_index_status`, `list_adrs`, `query_dependency_graph`, and
`run_integrity_check`.

`ask_codebase` remains visible while indexing, but it will not query a partial
or absent vector store. Until the SQLite coverage check is healthy, it returns a
structured, retryable tool error that directs the caller to `get_index_status`.
That status and `umbra://index-status` share one renderer: they report the live
process lifecycle plus the durable stamp and SQLite coverage without calling a
provider.

Indexing output is diagnostic-only on stderr. An interactive CLI repaints one
fixed-width, colour-coded row containing percent, file counter, truncated path,
vector counter, elapsed time, ETA, and current batch. Errors and milestones
finish that transient row and remain as permanent lines. Redirected output
receives complete lines, preserving stdout exclusively for JSON-RPC.

### Verification evidence

- `tool-catalog.spec.ts`, `resource-catalog.spec.ts`, and
  `sdk-server.spec.ts` — 12 tests passed, covering the stable catalog, the
  retryable indexing result, and the live index-status resource.
- `node node_modules/typescript/bin/tsc --noEmit --pretty false` — passed.
- `git diff --check` — passed.

### Related files added by this amendment

- `src/presentation/mcp/start-mcp-server.ts` — connects before background
  probe/index work and owns the lifecycle truth.
- `src/presentation/mcp/tool-catalog.ts` — stable status tool and readiness
  gate around semantic retrieval.
- `src/presentation/mcp/resource-catalog.ts` — reads live lifecycle status.
- `src/core/rag/indexer.ts` — compact progress observer and repaint format.
- `src/core/observability/console-sink.ts` — fixed-width terminal rendering.

---

### 13 — 2026-09-06 · A global client may declare, but never guess, its root

Global configuration has three trusted root paths. Claude's explicit
`CLAUDE_PROJECT_DIR` remains first. Codex's verified active project working
directory remains the normal path. If an auto-root client has no valid working
directory, Umbra completes the MCP handshake without opening a database and
requests the client's Roots capability.

Only one local `file:` root that independently passes the project and unsafe
directory checks is accepted. Multiple roots, non-file URIs, missing roots, and
unrecognised project declarations leave the server connected but root-gated:
`get_index_status` explains the recovery, while every root-bound tool returns a
retryable error. No `.umbra/`, `.gitignore`, SQLite database, provider probe, or
index run occurs in that state. Once one root is accepted, the existing
activation and background-index path applies unchanged.

### Verification evidence

- `project-root.spec.ts` covers one MCP `file:` root, multiple valid roots,
  and a non-file URI.
- `tool-catalog.spec.ts` and `resource-catalog.spec.ts` cover the root-gated
  stable catalog and the safe pre-root resource response.
- Focused MCP/RAG suites: 34 tests passed. `tsc --noEmit` and
  `git diff --check` passed.

### Related files added by this amendment

- `src/presentation/mcp/project-root.ts` — URI-to-root validation.
- `src/presentation/mcp/start-mcp-server.ts` — post-handshake Roots request.
- `src/presentation/mcp/tool-catalog.ts` and `resource-catalog.ts` — safe
  pre-root status and tool gates.
- `src/presentation/mcp/sdk-loader.ts` — minimal typed Roots capability.
- `src/bin/cli.ts` — CWD-first auto-root with Roots fallback.

---

### 14 — 2026-09-08 · Global MCP bootstrap is safe, and its runtime is complete

The former project-local configuration writer
`ensureUmbraMcpConfiguration` and its root-pinned `configureCodexMcp` companion
have been removed. Umbra now owns only the verified user-scoped Codex and Claude
adapters, and generic clients receive a copyable stdio definition. In
particular, `umbra init` and `umbra setup` never edit an existing local
`.mcp.json`.

The original top-level decision language remains historical. The current
boundary is more precise: MCP exposes no chat model, agent loop, command tool,
write tool, or caller-selected filesystem path. Once a client has declared one
trusted root, startup may create only that root's `.umbra/` state and
`.gitignore` entry, then call the configured embedding provider in background.
Those bootstrap actions are not MCP tool capabilities. Before root validation,
the server remains connected and root-gated without creating state or probing a
provider.

The clean-package smoke also found that CLI startup imports TypeScript through
workspace discovery before it can print help or accept MCP. `typescript@5.9.3`
is therefore an exact production dependency alongside the required
`@modelcontextprotocol/sdk@1.30.0`; treating it as a development-only package
would make a global installation fail before its first response.

### Verification evidence

- `mcp-config.spec.ts` asserts the global binary contract, Windows Claude
  wrapper, absence of a local `.mcp.json` writer, and both runtime dependencies.
- Full Jest run: 89 suites passed, 1 skipped; 797 tests passed, 5 skipped.
  `tsc --noEmit` and the production build passed.
- A fresh `npm pack` tarball was installed with `--omit=dev --ignore-scripts`.
  Its `umbra --help` command completed with exit 0.
- The installed tarball completed a rootless JSON-RPC initialize plus
  `tools/list` exchange with stdout containing only JSON-RPC and exactly the
  five stable tools. The empty client directory gained neither `.umbra/` nor
  `.gitignore`.
- Host-level client-registration smoke remains explicitly unverified on this
  machine: the installed Codex CLI cannot resolve its home directory and no
  Claude executable is present. The adapter command contracts are covered by
  unit tests; no temporary client entry was left behind.

### Related files

- `package.json` and `package-lock.json` — complete CLI runtime closure.
- `src/core/config/mcp-config.ts` — global-only verified adapters.
- `src/core/config/mcp-config.spec.ts` — runtime and no-local-writer contract.
- `src/bin/cli.ts` — accurate global MCP wording during manual initialization.
- `README.md` and `src/presentation/mcp/README.md` — current activation,
  coverage, and removal semantics.

### 15 — 2026-09-10 · The launch route is part of the handshake, and this repository's own entry contradicted the decision

This record says a client entry "invokes globally installed `umbra`". The
`.mcp.json` committed in this repository ran `npx -y @dastbal/umbra`, and the
difference is not cosmetic: it is the reason the server intermittently failed to
connect at all.

### Measured

Spawn to the `initialize` response — which is exactly the window a client's
connect timeout measures — alternating routes so the first spawn of a session
does not become the measurement:

| Route | Samples (ms) |
| --- | --- |
| `npx -y @dastbal/umbra` | 15,684 · 22,066 · 23,882 · **never answered in 60 s** · 11,657 · 13,912 |
| globally installed `umbra` | 11,431 · 13,535 |
| `node` at the global `cli.js` | 12,014 · 12,513 |

The medians are close. **What `npx` ruins is the tail.** `-y` answers the install
prompt; it does not skip the registry lookup, so every launch depends on the
network and the spread runs from 11.7 s to 24 s with outright failures in
between. A client with a 30-second connect timeout therefore fails
*sometimes* — which is harder to diagnose than failing always, and is what
happened twice in the session that measured this.

The two installed routes are equivalent within noise, so the shim is preferred:
it carries no absolute user path into a tracked file.

### Amendment 12's ordering held for the warm-up and not for the import block

Amendment 12 above — *The MCP handshake precedes provider work* — connects the
transport before provider probing and index work, precisely so warm-up cannot
delay the handshake. It did what it says. What it could not reach is what runs
before `startMcpServer`'s first line: `require`ing `indexer.js` cost 2,923 ms — 2,492 ms of it
`embeddings-resolver.js` pulling in the provider SDKs — and it was paid at module
load, before `connect`, and even under `--no-index` where the indexer is never
constructed. Loading it lazily took the local binary's handshake from 5.8–8.7 s
to 4.4–4.8 s, and collapsed the spread, which matters more than the median for a
failure that presents as an intermittent timeout.

### Consequence for a consumer, which this record should state

An install that reaches Umbra through `npx` is one network hiccup away from a
server that never connects, and the operator sees a timeout rather than a cause.
`umbra init` still does not touch `.mcp.json` — that constraint is unchanged and
deliberate — so the recommendation belongs in documentation and in this record:
**install the package and name the binary.** The published tarball is what a
consumer runs, so a fix to startup cost only reaches them on release.

### Verification evidence

- `spawn -> initialize` timings above, taken with `--no-index` on every route so
  indexing was never a variable, alternating to separate route cost from the
  cost of being first.
- The two `.mcp.json` forms were both exercised; the shim resolved and answered.

### 16 — 2026-09-10 · Readiness asks whether the index can answer, not whether it is current

This record's constraint says semantic retrieval "stays retryable until durable
vector coverage is verified". That held, and the verification was doing more than
the sentence claims: it ran the **full** index inspection on every
`ask_codebase` call.

Measured back to back on one index: **401 ms** for the full sweep against
**52 ms** for a check that touches no filesystem, while the search it guards is
2 to 5 ms. Of the eleven conjuncts the full report combines, exactly two are
expensive, and both exist to notice a change the database cannot see —
`discoverSources()` walks the tree and parses tsconfig, and the staleness check
md5-hashes every discovered source file.

### The distinction this amendment draws

Those two answer *is the index current?* The gate needs *can the index answer?*,
and the two have different remedies:

| State | Consequence | Gate |
| --- | --- | --- |
| a chunk has no vector for the active identity | the result set would be **wrong** | refuses |
| a source file changed since the last run | one answer may be **dated** | serves |

The second used to refuse the question entirely — in the middle of a refactor,
at exactly the moment somebody asks. Serving it is the better answer, and it is
honest only because the reply already carries the index's age: `withProvenance`
emits `indexedAt`, `filesIndexed` and `status` on every answer, so a caller
judges staleness itself rather than being told nothing. That was already wired.

**Retryability is unchanged for everything it was written about.** A warming
index, an absent stamp, a partial stamp, missing vectors, a chunkless file, a
dimension conflict and an active writer lease all still refuse, still name the
reason, and still direct the caller to `get_index_status`.

### Completeness moved rather than stopped

`get_index_status`, `umbra doctor --index` and the boot-time coverage check all
still run the full report. So do both benchmark runners, which refuse on a stale
index exactly as before — scoring an index is a different job from serving it,
and conflating them is what made the gate expensive.

### Rejected alternatives

- **Cache the full sweep behind a short TTL.** Still pays it every interval, and
  invents a staleness window that was not previously there. It keeps the contract
  literally while making the failure ADR-025 exists to prevent — a stale "ready"
  over a broken index — newly possible.
- **Swap md5 for mtime.** Keeps the cost structure and adds a second definition
  of "changed" beside the registry's hash, which is what `backfillNestGraph`'s
  own comment warns against.

### Verification evidence

- 401 ms against 52 ms, six runs each, alternating, on one index.
- `inspectIndexServeability`'s conjuncts are a strict subset of the full
  report's, so healthy implies serveable. Asserted over the same fixture the
  full inspection's spec uses, because two predicates about one index are the
  shape that drifts.
- An edited file and a newly added file are both serveable while the full report
  calls them unhealthy — the behaviour change, as a test rather than a claim.
- It fails closed: an unreadable index is reported unserveable with its reason.

## Amendment — 2026-09-14: MCP publishes validated results, not formatted internals

ADR-032 moves the six read-only MCP capabilities behind shared application executions. MCP now declares an `outputSchema`, validates `structuredContent` before returning it, and supplies the identical object as JSON text for older clients. `blocked` and `error` set `isError`; empty, abstained, and partial results remain successful protocol calls with explicit domain state. The read-only and pinned-root constraints of this record are unchanged.

## Amendment — 2026-09-18: Long-running calls prove they are alive

When an MCP client supplies `_meta.progressToken` on a tool call, Umbra sends a
request-bound `notifications/progress` message before executing the tool, then a
liveness heartbeat every 15 seconds until it returns. Progress is elapsed
seconds with no `total`, not an invented completion percentage: a semantic
search or integrity check can be active without a reliable estimate of how much
work remains. Clients that do not request progress receive the same tool result
and no extra notifications.

This does **not** turn the post-handshake index warm-up into a fake request.
That work is intentionally background work with no caller token; its exact
phase remains available through `get_index_status` and `umbra://index-status`.
The deferred design for a client-visible warm-up wait remains separate.

### Verification evidence

`sdk-server.spec.ts` drives a real stdio `tools/call` with a progress token and
asserts that the protocol notification precedes the typed result. Its companion
case proves a call without the token emits none, preserving clients that do not
implement progress handling.
