# NestJS AI Agent Lib

> Built by **David Balladares** — Principal Software Engineer level autonomous agent for NestJS.

An autonomous AI agent framework for NestJS codebases. Analyzes, plans, writes, and verifies code with specialized subagents — all via a premium streaming CLI that stays open like Claude or Gemini's terminal experience.

---

## Table of Contents

- [Overview](#overview)
- [Getting Started](#getting-started)
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

- 📋 **Plan** — uses `write_todos` to break tasks into steps before acting
- 🔍 **Analyze** — semantic search over your codebase via RAG (X-Ray strategy)
- 💾 **Write code** — safely, with automatic backup before every file write
- 🧪 **Test** — runs Jest + `tsc --noEmit` and self-corrects on failures
- 🤖 **Delegate** — spawns specialized Researcher and Coder subagents for complex tasks
- ✋ **Ask you** — HITL approval flow for risky operations
- 💬 **Remember** — full conversation history via SQLite, persistent across sessions

---

## Getting Started

### 1. Prerequisites

```bash
npm install
```

### 2. Configuration

```dotenv
# .env.development
GOOGLE_APPLICATION_CREDENTIALS=path/to/service-account.json
AGENT_MODEL=gemini-2.5-flash-lite   # optional — see LLM Switching below
```

### 3. Run

```bash
npm run agent -- deep
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

Sessions persist across terminal restarts via SQLite. The agent remembers everything.

```bash
# Default session — continues across all runs
npm run agent -- deep
npm run agent -- orchestrate

# Named session — create or continue by name
npm run agent -- deep --session auth-module
npm run agent -- deep --session users-refactor
npm run agent -- orchestrate --session big-feature

# Fresh session — no history, ephemeral
npm run agent -- deep --new
npm run agent -- orchestrate --new

# First message + named session (sends task, then stays open)
npm run agent -- deep "create a CacheModule" --session cache-work
```

**How it works:**
- `--session auth` → `threadId = "deep-auth"` → same SQLite rows every run → agent remembers
- `--new` → `threadId = "deep-new-1717530012789"` → unique, discarded after session
- No flag → `threadId = "deep-default"` → persistent main session

### LLM Switching

```powershell
# Lite (default) — fast, cheap, great for most tasks
$env:AGENT_MODEL="gemini-2.5-flash-lite"; npm run agent -- deep

# Flash — more capable
$env:AGENT_MODEL="gemini-2.5-flash"; npm run agent -- deep

# Pro — for complex architecture decisions
$env:AGENT_MODEL="gemini-2.5-pro"; npm run agent -- orchestrate

# Local (no API cost)
$env:AGENT_MODEL="ollama:llama3.2"; npm run agent -- deep
```

---

## Agent Modes

### `deep` — Single Autonomous Agent
Best for: most tasks. Debugging, analysis, single file changes, quick Q&A, medium complexity.

```bash
npm run agent -- deep
npm run agent -- deep --session my-session
npm run agent -- deep "explain src/core/agent/deep-agent-factory.ts" --new
```

**Built-in tools:**
| Tool | Purpose |
|---|---|
| `write_todos` | Create a plan before acting |
| `list_files` | List directory contents |
| `safe_read_file` | Read files (with path validation) |
| `safe_write_file` | Write files (with auto-backup) |
| `ask_codebase` | Semantic search over your codebase (RAG) |
| `run_integrity_check` | `tsc --noEmit` + lint |
| `run_tests` | Jest test suite |
| `task` | Launch a subagent for isolated work |
| `ask_human` | HITL — pause and ask you before proceeding |

---

### `orchestrate` — Multi-Subagent Coordinator
Best for: complex features, creating full modules, large refactors touching many files.

```bash
npm run agent -- orchestrate
npm run agent -- orchestrate --session big-refactor
```

**Flow enforced by system prompt:**
```
1. write_todos         → create step-by-step plan
2. task(researcher)    → analyze codebase, return findings + plan
3. task(coder)         → implement with TDD (spec first, then code)
4. run_integrity_check → verify types + lint
```

**Researcher subagent** — read-only analyst:
- Tools: `ask_codebase`, `safe_read_file`, `list_files`
- Never writes. Returns a structured analysis + implementation plan.

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
    │                  + SafeFilesystemBackend (auto-backup)
    │                  + RAG IndexerService (X-Ray)
    │                  + SqliteSaver (history)
    │
    └── orchestrate → DeepAgentFactory.createOrchestrator()
                         createDeepAgent with subagents:
                              ├── researcher (read-only)
                              └── coder (TDD-focused)
```

The `task` tool is the mechanism the Orchestrator uses to invoke subagents.
When the agent calls `task("researcher", "analyze auth module")`, a Researcher
DeepAgent spins up, runs to completion, and returns its findings as a string.

---

## Core Concepts

### SafeFilesystemBackend
Every `safe_write_file` call creates a backup in `.agent/backups/` before writing.
If the agent writes bad code, the backup is there. The agent is sandboxed to the project root.

### RAG X-Ray Strategy
1. `IndexerService` scans `src/` on startup, creates embeddings per code chunk
2. `ask_codebase` performs vector similarity search to find relevant code
3. Results include file content + dependency context → LLM gets deep understanding

### HITL (Human-in-the-Loop)
For risky operations, the agent pauses with an approval prompt:
```
  ✋  APPROVAL REQUIRED
  └─ Tool: 💾 safe_write_file
  └─ Args: { "file_path": "src/auth/auth.service.ts", ... }
  Approve? [approve/reject]
```

### Session Persistence
threadId → SQLite rows → full message history restored on next run.
The agent picks up exactly where the last session ended.

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
│   │   └── model-resolver.ts          # AGENT_MODEL env → LLM instance
│   ├── subagents/
│   │   ├── researcher.subagent.ts     # read-only analyst
│   │   └── coder.subagent.ts          # TDD implementer
│   ├── rag/
│   │   └── indexer.ts                 # X-Ray codebase indexer
│   └── tools/
│       └── index.ts                   # all custom tools
├── presentation/
│   └── cli/
│       ├── theme.ts                   # design system (colors, icons, box chars)
│       ├── stream-renderer.ts         # token/tool event → terminal output
│       ├── chat-session.ts            # interactive loop + HITL + session
│       └── index.ts                   # barrel export
.agent/
├── deep_agent_history.db              # deep mode SQLite
├── orchestrator_history.db            # orchestrate mode SQLite
└── backups/                           # auto-backups before every write
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
| Sessions | `--session` / `--new` persistence | ✅ Done |
| 5 | Context compression (long tasks) | ⏳ Planned |
| 6 | SSE HTTP API (`/agent/stream`) | ⏳ Planned |
| 7 | Skills system (`SKILL.md` reusable strategies) | ⏳ Planned |

---

## License

MIT — David Balladares
