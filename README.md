# NestJS AI Agent Lib

> Built by **David Balladares** — Principal Software Engineer level autonomous agent for NestJS.

An autonomous AI agent framework for NestJS codebases. Analyzes, plans, writes, and verifies code with specialized subagents — all via a premium streaming CLI. Runs on **Google Gemini (Vertex AI)** or **locally with Ollama** — no API key required for local models.

---

## Table of Contents

- [Overview](#overview)
- [Getting Started](#getting-started)
  - [Option A — Ollama (Local, Free, No API Key)](#option-a--ollama-local-free-no-api-key-)
  - [Option B — Google Gemini (Cloud)](#option-b--google-gemini-cloud)
- [CLI — Interactive Streaming Sessions](#cli--interactive-streaming-sessions)
  - [Session Management](#session-management)
  - [Switching Models — /model command](#switching-models---model-command)
  - [LLM Switching via env var](#llm-switching-via-env-var)
- [Agent Modes](#agent-modes)
- [Architecture](#architecture)
- [Core Concepts](#core-concepts)
- [Project Structure](#project-structure)
- [Roadmap](#roadmap)

---

## Overview

This library gives your NestJS project an autonomous AI agent that can:

- 📋 **Plan** — classifies task size (SMALL/MEDIUM/LARGE) and plans accordingly
- 🔍 **Analyze** — semantic search over your codebase via RAG (X-Ray strategy)
- 💾 **Write code** — safely, with automatic backup before every file write
- 🧪 **Test** — runs Jest + `tsc --noEmit` and self-corrects on failures
- 🤖 **Delegate** — spawns specialized Researcher and Coder subagents for complex tasks
- ✋ **Ask you** — HITL approval flow for risky operations (delete, drop table, infra files)
- 💬 **Remember** — full conversation history via SQLite, persistent across named sessions
- 🧠 **Compress** — auto-summarizes long sessions so context never overflows
- 🎨 **Render beautifully** — markdown responses styled with chalk (headers, code blocks, bold, bullets)
- 🔁 **Work autonomously** — executes full plans without stopping for `yes/no` confirmation
- 🩹 **Self-heal** — auto-recovers corrupted sessions (SQLite checkpoint corruption)
- 🦙 **Run locally** — full Ollama support: use Gemma4, Qwen3.6, Llama3.2 and more — free, offline, no API key

---

## Getting Started

### Option A — Ollama (Local, Free, No API Key) 🦙

The fastest way to get started — runs entirely on your machine.

**1. Install [Ollama](https://ollama.com) and pull a model:**

```bash
ollama pull gemma4        # ~10 GB — best balance locally
ollama pull gemma4:e2b    # ~7 GB — faster, less RAM
ollama pull qwen3.6       # ~4 GB — strong reasoning, compact
```

**2. Install dependencies:**

```bash
npm install
```

**3. Configure `.env.development`:**

```dotenv
# .env.development
AGENT_MODEL=ollama:gemma4
# OLLAMA_BASE_URL=http://localhost:11434   # default — only change if Ollama runs on a different port
```

**4. Run:**

```bash
npm run agent -- deep
```

That's it. No Google account, no API key, no billing.

> **Tip:** Inside the session, type `/model` to switch between Ollama models (or switch to Gemini cloud) interactively.

---

### Option B — Google Gemini (Cloud)

Gemini models run on **Google Vertex AI**. The agent uses Application Default Credentials (ADC).

#### Option B1 — Your personal Google account (recommended for local dev) ✅

```bash
# 1. Install gcloud CLI: https://cloud.google.com/sdk/docs/install

# 2. Authenticate + set your GCP project:
gcloud auth application-default login --project YOUR_GCP_PROJECT_ID

# 3. Configure:
# .env.development
# AGENT_MODEL=gemini-2.5-flash-lite

# 4. Run:
npm run agent -- deep
```

#### Option B2 — Service Account (CI/CD, production)

```bash
# Required IAM roles:
# - roles/aiplatform.user  ← call Vertex AI models
```

```dotenv
# .env.development
GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/service-account.json
AGENT_MODEL=gemini-2.5-flash-lite
```

> **⚠️ Important:** Service account must have `Vertex AI User` role (`roles/aiplatform.user`).
> Assign it in GCP Console → **IAM & Admin → IAM → Grant Access**.

---

## CLI — Interactive Streaming Sessions

The CLI stays open like Claude/Gemini's terminal. Tokens stream in real-time,
tool calls show a live spinner with elapsed time, and `You:` waits for your next message.

```
╭────────────────────────────────────────────────╮
│                                                │
│  NestJS AI Agent — Deep Mode                  │
│  Single autonomous agent with planning tools  │
│  Model: ollama:gemma4                         │
│  Session: auth-module (continuing)            │
│  Type your task. Ctrl+C to exit.              │
│                                                │
╰────────────────────────────────────────────────╯

You: create a UsersModule following DDD

  ⠋  Thinking...
╭─ 📋  write_todos
│  └─ Creating implementation plan...
╰─ ✓  done in 1.2s

╭─ 🔍  ask_codebase
│  └─ How is AuthModule structured?
╰─ ✓  done in 3.4s

Agent: I'll implement UsersModule following the same DDD pattern as AuthModule...
       (tokens stream as they're generated)

──────────────────────────────────────────────────

You: ▌
```

### Session Management

| Command | Behavior |
|---|---|
| `npm run agent -- deep` | **Ephemeral** — fresh thread every run |
| `npm run agent -- deep --session auth` | **Persistent** — always reopens the `auth` context |
| `npm run agent -- orchestrate --session big-feat` | Same, for the orchestrator |

```bash
# Ephemeral — scratch work, quick questions
npm run agent -- deep
npm run agent -- deep "explain src/core/agent/deep-agent-factory.ts"

# Named sessions — real work you want to continue
npm run agent -- deep --session auth-module
npm run agent -- orchestrate --session big-feature

# First message + session
npm run agent -- deep "create a CacheModule" --session cache-work
```

> Sessions are stored in `.agent/deep_agent_history.db` and `.agent/orchestrator_history.db`.

---

### Switching Models — `/model` command

Inside any chat session, type `/model` to switch models interactively **without losing your session**:

```
You: /model

╭────────────────────────────────────────────────────╮
│  🔧  Switch LLM Model                              │
│  Type the number and press Enter.                  │
│  Press 0 or Enter to cancel.                       │
╰────────────────────────────────────────────────────╯

  Select Provider:
  1. ⚡  Vertex AI  (Gemini cloud — requires Google credentials)
  2. 🦙  Ollama     (Local models — free, no API key needed)  ← active
  Provider: 2

  Detecting Ollama models... ✓ (4 found)

  Select Ollama Model:
  1. gemma4:26b  (17 GB)
  2. gemma4:e2b  (7.2 GB)
  3. gemma4:e4b  (9.6 GB)
  4. gemma4      (9.6 GB)
  Model: 1

  ✅ Switching to ollama:gemma4:26b
  💾 Saved to .env
  🔄 Restarting agent with new model...
```

The new model is saved to `.env` and persists across sessions.

Other slash commands:

| Command | Description |
|---|---|
| `/model` | Switch LLM provider and model interactively |
| `/help` | List all available slash commands |

---

### LLM Switching via env var

You can also switch models at startup via `AGENT_MODEL`:

```powershell
# Windows PowerShell

# ── Ollama (local, free) ──────────────────────────────────────
$env:AGENT_MODEL="ollama:gemma4";       npm run agent -- deep   # balanced local
$env:AGENT_MODEL="ollama:gemma4:e2b";   npm run agent -- deep   # fast, low RAM
$env:AGENT_MODEL="ollama:gemma4:26b";   npm run agent -- deep   # high quality
$env:AGENT_MODEL="ollama:qwen3.6";      npm run agent -- deep   # strong reasoning
$env:AGENT_MODEL="ollama:llama3.2";     npm run agent -- deep   # general purpose

# ── Vertex AI (cloud) ─────────────────────────────────────────
$env:AGENT_MODEL="gemini-2.5-flash-lite"; npm run agent -- deep    # fast & cheap (default)
$env:AGENT_MODEL="gemini-2.5-flash";      npm run agent -- deep    # more capable
$env:AGENT_MODEL="gemini-2.5-pro";        npm run agent -- orchestrate  # architecture tasks
```

```bash
# Linux / macOS
AGENT_MODEL=ollama:gemma4 npm run agent -- deep
AGENT_MODEL=gemini-2.5-pro npm run agent -- orchestrate
```

**All model tiers:**

| Tier alias | Model string | Provider | Best for |
|---|---|---|---|
| `gemma` | `ollama:gemma4` | 🦙 Local | Best local model for coding |
| `gemma-2b` | `ollama:gemma4:e2b` | 🦙 Local | Fast, low RAM (~7 GB) |
| `gemma-4b` | `ollama:gemma4:e4b` | 🦙 Local | Balance speed/quality |
| `gemma-26b` | `ollama:gemma4:26b` | 🦙 Local | High quality (~17 GB) |
| `qwen` | `ollama:qwen3.6` | 🦙 Local | Strong reasoning, compact |
| `local` | `ollama:llama3.2` | 🦙 Local | General purpose offline |
| `lite` | `gemini-2.5-flash-lite` | ⚡ Cloud | Quick edits, Q&A (default) |
| `flash` | `gemini-2.5-flash` | ⚡ Cloud | Balanced speed + quality |
| `pro` | `gemini-2.5-pro` | ⚡ Cloud | Architecture, complex refactors |
| `claude` | `anthropic:claude-opus-4-7` | ☁️ Cloud | Maximum code quality |

> **Embeddings are always Vertex AI** (`text-embedding-004`) regardless of the chat model.
> This keeps the RAG index stable when switching between Ollama and Gemini.

---

## Agent Modes

### `deep` — Single Autonomous Agent

Best for: most tasks — debugging, analysis, single-file changes, quick Q&A, medium complexity.

```bash
npm run agent -- deep
npm run agent -- deep --session my-session
npm run agent -- deep "explain src/core/agent/deep-agent-factory.ts"
```

**Task sizing — the agent auto-classifies before acting:**
- `SMALL` (1-2 files, obvious change) → reads → writes → done. Max 3 tool calls.
- `MEDIUM` (3+ files, new feature) → brief `write_todos` → executes.
- `LARGE` (full module, major refactor) → full protocol with step-by-step todos.

**Built-in tools:**

| Tool | Purpose |
|---|---|
| `write_todos` | Create a plan before acting (MEDIUM/LARGE tasks only) |
| `list_files` | List directory contents |
| `safe_read_file` | Read files (path-validated, sandboxed to project root) |
| `safe_write_file` | Write files (auto-backup to `.agent/backups/`) |
| `ask_codebase` | Semantic search over your codebase (RAG) |
| `refresh_project_index` | Rebuild the RAG index after bulk writes |
| `run_integrity_check` | `tsc --noEmit` — zero TypeScript errors required |
| `run_tests` | Run Jest (full suite or specific file) |

---

### `orchestrate` — Multi-Subagent Coordinator

Best for: complex features, full modules, large refactors touching many files.

```bash
npm run agent -- orchestrate
npm run agent -- orchestrate --session big-refactor
```

**Mandatory flow (enforced by system prompt):**

```
1. write_todos         → create step-by-step plan
2. task(researcher)    → analyze codebase, return structured implementation plan
3. task(coder)         → implement with TDD (spec first, then implementation)
4. run_integrity_check → verify zero TypeScript errors
```

**Researcher subagent** — read-only analyst:
- Tools: `ask_codebase`, `safe_read_file`, `list_files`
- Never writes. Returns a structured implementation plan.

**Coder subagent** — TDD implementer:
- Tools: `safe_write_file`, `safe_read_file`, `run_tests`, `run_integrity_check`
- Writes `.spec.ts` BEFORE implementation.
- Self-corrects up to 3 times on test failures.

---

### Legacy modes (museum 🏛️)

```bash
npm run agent -- classic "task"   # original ReAct agent (AgentFactory)
npm run agent -- "task"           # original StateGraph (GraphAgentFactory)
```

Kept for historical reference. Not recommended for new work.

---

## Architecture

```
CLI (interactive streaming)
    │
    ├── /model slash command
    │       ├── ModelSwitcher.detectOllamaModels()  ← runs 'ollama list'
    │       ├── Two-level menu: provider → model
    │       └── ModelSwitcher.saveModelToEnv()      ← persists to .env
    │
    ├── deep      → DeepAgentFactory.create()
    │                  LLMProvider.createChatModel(model)  ← for Ollama
    │                  │   └── OllamaChatAdapter           ← serializes tool content
    │                  createDeepAgent (deepagents lib)
    │                  + Lazy RAG indexing (skips if index < 5 min old)
    │                  + SafeFilesystemBackend (auto-backup on every write)
    │                  + SqliteSaver (SQLite history — ephemeral or named)
    │                  + Task sizing system prompt (SMALL/MEDIUM/LARGE)
    │
    └── orchestrate → DeepAgentFactory.createOrchestrator()
                         createDeepAgent with subagents:
                              ├── researcher (read-only analyst)
                              └── coder (TDD-focused implementer)
```

### Provider Routing

```
AGENT_MODEL env var
       │
       ├── "ollama:*"       → OllamaChatAdapter (ChatOllama + content serialization)
       │                        baseUrl: OLLAMA_BASE_URL ?? "http://localhost:11434"
       │
       └── "gemini-*" / bare name → ChatVertexAI (Google Vertex AI)
                                       requires GOOGLE_APPLICATION_CREDENTIALS or gcloud login
```

> **Embeddings:** Always Vertex AI (`text-embedding-004`) — even when the chat model is Ollama.
> Rationale: Ollama embedding models have lower quality and would force a full RAG re-index
> on every provider switch. Using a stable cloud embeddings model keeps the index consistent.

---

## Core Concepts

### Ephemeral vs. Named Sessions

| Mode | threadId | SQLite | Behavior |
|---|---|---|---|
| No `--session` | `deep-ephemeral-{timestamp}` | Temporary | Fresh every run |
| `--session auth` | `deep-auth` | Permanent | Remembers everything |

### SafeFilesystemBackend
Every `safe_write_file` call creates a timestamped backup in `.agent/backups/` before writing.
If the agent writes bad code, the original is always recoverable. The agent is sandboxed
to the project root — it cannot read or write outside it.

### RAG X-Ray Strategy
1. `IndexerService` scans `src/` on startup (lazy — skips if index is fresh < 5 min)
2. `ask_codebase` performs vector similarity search to find relevant code chunks
3. Results include file content + dependency context → LLM gets deep structural understanding

> When using Ollama (no Vertex AI credentials), RAG indexing is gracefully skipped.
> The agent still works — it just won't have semantic search over your codebase.

### OllamaChatAdapter
Ollama's API only accepts `string` content in messages. LangChain's `ToolMessage` can hold
objects or arrays (e.g., when `read_file` returns structured data). `OllamaChatAdapter`
transparently serializes any non-string tool message content to JSON before the API call,
preventing the `"Non string tool message content is not supported"` crash.

### HITL (Human-in-the-Loop)
For operations flagged as risky, the agent pauses with an approval prompt:
```
  ✋  APPROVAL REQUIRED
  └─ Tool: 💾 safe_write_file
  └─ Args: { "file_path": "src/auth/auth.service.ts", ... }
  Approve? [approve/reject]
```

### Auto-Recovery
If a named session is corrupted (e.g., interrupted during a streaming tool call),
the agent automatically detects and clears only the corrupted checkpoint, then retries
the session without losing other history.

---

## Project Structure

```
src/
├── bin/
│   └── cli.ts                         # CLI entry — deep, orchestrate, classic
├── core/
│   ├── agent/
│   │   ├── factory.ts                 # 🏛️ museum — classic ReAct
│   │   ├── graph-factory.ts           # 🏛️ museum — StateGraph
│   │   ├── deep-agent-factory.ts      # ⭐ active — createDeepAgent
│   │   └── safe-backend.ts            # auto-backup filesystem
│   ├── config/
│   │   ├── model-resolver.ts          # AGENT_MODEL env → LLM string + provider detection
│   │   └── model-switcher.ts          # detectOllamaModels(), saveModelToEnv()
│   ├── llm/
│   │   ├── provider.ts                # LLMProvider — routes to Vertex AI or Ollama
│   │   └── ollama-adapter.ts          # OllamaChatAdapter — serializes tool content
│   ├── subagents/
│   │   ├── researcher.subagent.ts     # read-only analyst
│   │   └── coder.subagent.ts          # TDD implementer
│   ├── rag/
│   │   └── indexer.ts                 # X-Ray codebase indexer (lazy)
│   └── tools/
│       └── index.ts                   # all custom tools
├── presentation/
│   └── cli/
│       ├── theme.ts                   # design system (colors, icons, box chars)
│       ├── stream-renderer.ts         # token/tool event → terminal output
│       ├── chat-session.ts            # interactive loop + HITL + /model + /help
│       ├── model-menu.ts              # interactive provider/model selector UI
│       └── index.ts                   # barrel export
.agent/
├── deep_agent_history.db              # deep mode SQLite (named sessions)
├── orchestrator_history.db            # orchestrate mode SQLite (named sessions)
├── index.meta.json                    # RAG index freshness timestamp
└── backups/                           # timestamped backups before every write
```

---

## Roadmap

| Phase | Feature | Status |
|---|---|---|
| 0 | DeepAgentFactory base | ✅ Done |
| 1 | LLM switching (`AGENT_MODEL` env) | ✅ Done |
| 2 | Researcher subagent | ✅ Done |
| 3 | Coder subagent (TDD) | ✅ Done |
| 4 | Orchestrator (Researcher + Coder) | ✅ Done |
| CLI | Premium streaming sessions | ✅ Done |
| Sessions | Ephemeral by default / `--session` for persistence | ✅ Done |
| Perf | Lazy RAG indexing (skip if fresh < 5 min) | ✅ Done |
| UX | Task sizing (SMALL/MEDIUM/LARGE auto-classification) | ✅ Done |
| Safety | Auto-recovery for corrupted checkpoints | ✅ Done |
| **v1.3.0** | **Ollama local inference — full multi-provider support** | ✅ **Done** |
| | `/model` interactive switcher inside chat session | ✅ Done |
| | OllamaChatAdapter — serializes non-string tool content | ✅ Done |
| | All gemma4 variants + qwen3.6 model tiers | ✅ Done |
| 6 | SSE HTTP API (`/agent/stream`) | ⏳ Planned |
| 7 | Skills system (`SKILL.md` reusable strategies) | ⏳ Planned |

---

## License

MIT — David Balladares
