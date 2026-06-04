# NestJS AI Agent Lib

> Built by **David Balladares** — Principal Software Engineer level autonomous agent for NestJS.

An autonomous AI agent framework for NestJS codebases. Analyzes, plans, writes, and verifies code with specialized subagents — all via a premium streaming CLI that stays open like Claude or Gemini's terminal experience.

---

## Table of Contents

- [Overview](#overview)
- [Getting Started](#getting-started)
  - [Google Gemini — Authentication](#google-gemini--authentication)
- [CLI — Interactive Streaming Sessions](#cli--interactive-streaming-sessions)
  - [Session Management](#session-management)
  - [LLM Switching](#llm-switching)
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
- ✋ **Ask you** — HITL approval flow for risky operations
- 💬 **Remember** — full conversation history via SQLite, persistent across named sessions

---

## Getting Started

### 1. Install dependencies

```bash
npm install
```

### 2. Configure your LLM

Create a `.env.development` file in the project root:

```dotenv
# .env.development

# LLM model to use (see LLM Switching below for all options)
AGENT_MODEL=gemini-2.5-flash-lite

# Only needed for Service Account auth (see section below)
# GOOGLE_APPLICATION_CREDENTIALS=path/to/service-account.json
```

### 3. Run

```bash
npm run agent -- deep
```

---

## Google Gemini — Authentication

Gemini models run on **Google Vertex AI** or **Google AI Studio**. The agent uses
Google's Application Default Credentials (ADC) — the same standard the entire
Google Cloud SDK uses.

You have **two options**:

---

### Option A — Your personal Google account (recommended for local dev) ✅

Log in with your Google account via the `gcloud` CLI. This is the easiest path —
no keys, no files, no service accounts.

```bash
# 1. Install gcloud CLI if you don't have it:
#    https://cloud.google.com/sdk/docs/install

# 2. Authenticate with your Google account + set your GCP project:
gcloud auth application-default login --project YOUR_GCP_PROJECT_ID

# 3. That's it. Run the agent:
npm run agent -- deep
```

**How it works:** `gcloud auth application-default login` stores a credential file
at `~/.config/gcloud/application_default_credentials.json`. The Google SDK
automatically picks it up — no `GOOGLE_APPLICATION_CREDENTIALS` env var needed.

> **Why `--project`?** Vertex AI bills per project. Setting it here ensures API
> calls go to the right GCP project and quota is correctly attributed.

---

### Option B — Service Account (CI/CD, production, shared environments)

Create a service account in your GCP project and download its JSON key:

```bash
# Required IAM roles on the service account:
# - roles/aiplatform.user     ← call Vertex AI models
# - roles/ml.developer        ← (optional) broader AI Platform access
```

Then configure the env var:

```dotenv
# .env.development
GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/service-account.json
AGENT_MODEL=gemini-2.5-flash-lite
```

> **⚠️ Important:** The service account must have the `Vertex AI User` role
> (`roles/aiplatform.user`) on the project. Without it, API calls will return
> `403 PERMISSION_DENIED`. Assign it in the GCP Console →
> **IAM & Admin → IAM → Grant Access**.

---

### Verify your auth is working

```bash
# Should print your active account and project
gcloud auth application-default print-access-token

# Or run a quick agent test
npm run agent -- deep "hola, estás funcionando?"
```

---

## CLI — Interactive Streaming Sessions

The CLI stays open like Claude/Gemini's terminal. Tokens stream in real-time,
tool calls show a live spinner with elapsed time, and `You:` waits for your next message.

```
╭────────────────────────────────────────────────╮
│                                                │
│  NestJS AI Agent — Deep Mode                  │
│  Single autonomous agent with planning tools  │
│  Model: gemini-2.5-flash-lite                 │
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

Sessions work like this:

| Command | Behavior |
|---|---|
| `npm run agent -- deep` | **Ephemeral** — fresh thread every run, nothing is saved |
| `npm run agent -- deep --session auth` | **Persistent** — always reopens the `auth` context |
| `npm run agent -- orchestrate --session big-feat` | Same, for the orchestrator |

**The golden rule:**
- **No `--session`** → random threadId → independent, ephemeral chat → discarded on exit
- **`--session <name>`** → fixed threadId → SQLite persists full history → pick up exactly where you left off

```bash
# Ephemeral — quick one-off questions, scratch work
npm run agent -- deep
npm run agent -- deep "explain src/core/agent/deep-agent-factory.ts"

# Named sessions — real work you want to continue
npm run agent -- deep --session auth-module
npm run agent -- deep --session users-refactor
npm run agent -- orchestrate --session big-feature

# First message + session (sends task immediately, then stays open)
npm run agent -- deep "create a CacheModule" --session cache-work
```

> Sessions are stored in `.agent/deep_agent_history.db` and `.agent/orchestrator_history.db`.
> Delete those files (or just don't use `--session`) to start completely fresh.

### LLM Switching

Switch models at runtime via the `AGENT_MODEL` env var — no code changes needed.

```powershell
# Windows PowerShell
$env:AGENT_MODEL="gemini-2.5-flash-lite"; npm run agent -- deep    # default — fast & cheap
$env:AGENT_MODEL="gemini-2.5-flash";      npm run agent -- deep    # more capable
$env:AGENT_MODEL="gemini-2.5-pro";        npm run agent -- orchestrate  # architecture tasks
$env:AGENT_MODEL="ollama:llama3.2";       npm run agent -- deep    # local, no API cost
```

```bash
# Linux / macOS
AGENT_MODEL=gemini-2.5-pro npm run agent -- orchestrate
```

Or set it permanently in `.env.development`:

```dotenv
AGENT_MODEL=gemini-2.5-flash-lite
```

**Available tiers:**

| Tier | Model | Best for |
|---|---|---|
| `lite` | `gemini-2.5-flash-lite` | Quick edits, Q&A, most tasks |
| `flash` | `gemini-2.5-flash` | Balanced speed + quality |
| `pro` | `gemini-2.5-pro` | Architecture, complex refactors |
| `claude` | `anthropic:claude-opus-4-7` | Maximum code quality |
| `local` | `ollama:llama3.2` | Offline, no API cost |

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
| `delete_file` | Delete a file (sandboxed) |
| `ask_codebase` | Semantic search over your codebase (RAG) |
| `refresh_project_index` | Rebuild the RAG index after bulk writes |
| `run_integrity_check` | `tsc --noEmit` — zero TypeScript errors required |
| `run_tests` | Run Jest (full suite or specific file) |
| `ask_human` | HITL — pause and ask you before proceeding |

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
    ├── deep      → DeepAgentFactory.create()
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

The `task` tool is the mechanism the Orchestrator uses to invoke subagents.
When the agent calls `task("researcher", "analyze auth module")`, a Researcher
DeepAgent spins up, runs to completion, and returns its findings as a string.

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

### HITL (Human-in-the-Loop)
For operations flagged as risky, the agent pauses with an approval prompt:
```
  ✋  APPROVAL REQUIRED
  └─ Tool: 💾 safe_write_file
  └─ Args: { "file_path": "src/auth/auth.service.ts", ... }
  Approve? [approve/reject]
```

### Session Persistence
`--session <name>` → fixed `threadId` → SQLite rows → full message history restored on next run.
The agent picks up exactly where the last session ended, including tool call history.

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
│   │   └── model-resolver.ts          # AGENT_MODEL env → LLM string resolution
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
│       ├── chat-session.ts            # interactive loop + HITL + session
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
| 6 | SSE HTTP API (`/agent/stream`) | ⏳ Planned |
| 7 | Skills system (`SKILL.md` reusable strategies) | ⏳ Planned |

---

## License

MIT — David Balladares
