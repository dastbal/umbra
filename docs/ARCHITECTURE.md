# 🏗️ Architecture: Umbra

> Living document — updated with every completed phase.
> Read this to understand WHAT exists, WHY it exists, and WHERE we're going.

---

## Overview

This library implements an autonomous AI agent system for NestJS codebases.
The agent can analyze a codebase, plan tasks, write code with tests, and
self-correct — all following DDD and TDD principles.

---

## Amendment 2026-09-02 — the roadmap below is behind the code

This document described Phases 1–6 as pending. They are all shipped. It was
also written before the parts that now carry the runtime existed, so the
"Target Architecture" diagram further down no longer shows the real system.

Nothing below has been deleted: the phase entries still record *why* each step
was taken, and that reasoning is still accurate. Only the status is corrected
here, plus the modules the document never mentioned.

**Roadmap status, verified against `src/`:**

| Phase | Recorded | Actual | Evidence |
|---|---|---|---|
| 1 — LLM switch | ⏳ | ✅ | `core/config/model-resolver.ts` |
| 2 — Researcher | ⏳ | ✅ | `core/subagents/researcher.subagent.ts` |
| 3 — Coder | ⏳ | ✅ | `core/subagents/coder.subagent.ts` |
| 4 — Orchestrator | ⏳ | ✅ | `core/agent/deep-agent-factory.ts` + `core/agent/delegation/` |
| 5 — Compression | ⏳ | ✅ *(diverged)* | `core/agent/context-compressor.ts` |
| 6 — SSE streaming | ⏳ | ✅ | `presentation/http/agent-http.contracts.ts` |
| 7 — Skills system | ⏳ | ⏳ | no `src/skills/` — still genuinely pending |

**Phase 5 diverged from its plan and the divergence matters.** The entry below
specifies `createSummarizationMiddleware` from deepagents. What was built is a
first-party `ContextCompressor` class with its own summarizer-model fallback
chain. The recorded intent stands; the mechanism is ours, not the library's.

**A third subagent exists that no phase planned:**
`core/subagents/verifier.subagent.ts`.

### Modules this document never described

These carry the runtime today and appear in no section below:

| Module | Role |
|---|---|
| `core/agent/agent-kernel.ts` | Role profiles, capability registry, kernel instructions (`KERNEL_API_VERSION`) |
| `core/agent/delegation/` | Delegation broker, mandate, shared budget pool, readback, subagent registry |
| `core/agent/turn-governor.ts` | Bounds a turn by cost — with `budget-probe`, `iteration-budget.middleware`, `orchestration-guard.middleware` |
| `core/security/` | `agent-security-policy.ts`, plus `tools/utils/authorize.ts` and path containment |
| `core/state/` | SQLite checkpointing and the file registry |
| `core/llm/` | Provider adapters: Vertex, Ollama |
| `core/observability/` | LangSmith config, metrics, trace flush |
| `core/application/services/cost-tracker.service.ts` | Per-turn cost accounting |
| `core/agent/evidence-protocol.ts` | Evidence rules for claims the agent makes |

### The current map

An interactive, validated diagram of the runtime as it actually is lives at
[`docs/diagrams/umbra-runtime.architecture.json`](diagrams/umbra-runtime.architecture.json).
It was traced from the source tree and the import graph, not from this document.

Regenerate the viewable HTML with:

```bash
npx -y skills@latest use tt-a1i/archify@archify
```

The JSON is the source of truth and is versioned; the ~719 KB HTML is a build
artifact and deliberately is not. The same JSON always renders the same HTML.

**Prefer that diagram over the ASCII "Target Architecture" block below**, which
is kept as the record of what was originally intended.

---

## System Evolution (Build Log)

### 🏛️ Era 1: Classic ReAct Agent (`factory.ts`)
**When:** Initial version
**What:** A `createReactAgent` from LangChain — the most basic pattern.
**How it works:**
```
User → LLM → decides which tool to call → executes tool → LLM → decides → ...
```
**Problem:** No planning, no context compression, no HITL. Just a basic loop.

---

### 🏛️ Era 2: Multi-Agent Graph (`graph-factory.ts`)
**When:** v1.2.0 pre-deep
**What:** A `StateGraph` from LangGraph with 3 explicit nodes:
```
Supervisor → (routing) → Researcher → returns → Supervisor
                      → (routing) → Coder     → returns → Supervisor
                      → FINISH
```
**Why it was an improvement:**
- Separated roles: Researcher only reads, Coder only writes
- Supervisor uses structured output to decide who to delegate to

**Problem:** All orchestration is manual code. No `write_todos`, no context
compression, no native HITL. Too much boilerplate.

---

### ⭐ Era 3: Deep Agent (`deep-agent-factory.ts`) — ACTIVE TODAY
**When:** 2026-06-04, commit `a62aadc`
**What:** An agent built with `createDeepAgent` from the `deepagents` library.

**Why `createDeepAgent` is better:**
```
createReactAgent (LangChain base)
  + FilesystemMiddleware  → write_file, read_file, edit_file
  + PlanningMiddleware    → write_todos, read_todos, update_todo
  + SubAgentMiddleware    → task (launch subagents)
  + SummarizationMiddleware → automatic context compression
  = createDeepAgent
```
In other words: `createDeepAgent` = `createReactAgent` + superpowers for free.

**Available tools in Deep Agent mode:**

| Tool | Source | Purpose |
|---|---|---|
| `write_todos` | deepagents built-in | Create a plan before acting |
| `read_todos` | deepagents built-in | Re-read the plan if lost |
| `update_todo` | deepagents built-in | Mark steps as completed |
| `task` | deepagents built-in | Launch a specialized subagent |
| `ask_human` | deepagents built-in | Ask the human for help (HITL) |
| `read_file` | deepagents built-in | Read a file from disk |
| `write_file` | deepagents built-in | Write a file to disk |
| `edit_file` | deepagents built-in | Edit exact string fragments in a file |
| `ls` | deepagents built-in | List directory contents |
| `safe_write_file` | ours (SafeFilesystemBackend) | Write with auto-backup |
| `safe_read_file` | ours (SafeFilesystemBackend) | Read with validation |
| `list_files` | ours | List with filters |
| `ask_codebase` | ours (RAG) | Semantic search over the codebase |
| `refresh_project_index` | ours (RAG) | Re-index after writes |
| `run_integrity_check` | ours | Run `tsc --noEmit` + lint |
| `run_tests` | ours | Run Jest test suite |

**Key bug fixed — Gemini Incompatibility:**
`deepagents` v1.10.x includes a `grep` tool whose Zod schema uses union types.
Gemini rejects union types in function calling schemas. Solution:
```typescript
// Must use the EXACT model string as the harness profile key
registerHarnessProfile('gemini-2.5-flash-lite', {
  excludedTools: ['grep', 'glob']
});
```
The harness profile is deepagents' mechanism for customizing the tool set per model.
The key must be the exact model string passed to `createDeepAgent` (not 'google').

---

## Target Architecture (What We're Building)

```
┌──────────────────────────────────────────────────────────────────┐
│                  CLI / API (Presentation)                         │
│  umbra deep "task"             |  POST /agent/stream (SSE)       │
└─────────────────────────┬────────────────────────────────────────┘
                          │
┌─────────────────────────▼────────────────────────────────────────┐
│                       ORCHESTRATOR                                │
│               DeepAgent (createDeepAgent)                        │
│          model: AGENT_MODEL (env configurable)                   │
│                                                                   │
│  Mandatory protocol:                                             │
│  1. write_todos → create plan                                    │
│  2. task(researcher) → analyze codebase                          │
│  3. task(coder) → implement                                      │
│  4. run_integrity_check → verify                                 │
└──────────┬───────────────────────────────┬───────────────────────┘
           │ tool: task()                  │ tool: task()
           ▼                               ▼
┌──────────────────────┐   ┌──────────────────────────────────────┐
│   RESEARCHER         │   │   CODER                              │
│   SubAgent           │   │   SubAgent                           │
│   (DeepAgent)        │   │   (DeepAgent)                        │
│                      │   │                                      │
│  Read-only:          │   │  Write-focused:                      │
│  - ask_codebase      │   │  - safe_write_file (with backup)     │
│  - safe_read_file    │   │  - safe_read_file                    │
│  - list_files        │   │  - run_tests                         │
│  - write_todos       │   │  - run_integrity_check               │
│                      │   │  - write_todos                       │
│  Returns: analysis   │   │  Returns: implemented code           │
│  + detailed plan     │   │  + test results                      │
└──────────────────────┘   └──────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────────────┐
│                     INFRASTRUCTURE                               │
│  SafeFilesystemBackend → backup before every write               │
│  SqliteSaver → conversation persistence (thread_id)             │
│  IndexerService (RAG) → codebase embeddings                     │
│  ModelResolver → AGENT_MODEL env → LangChain LLM instance       │
└──────────────────────────────────────────────────────────────────┘
```

---

## Phase Roadmap

### ✅ Phase 0 — Deep Agent Base
Commit `a62aadc` | `DeepAgentFactory` with `createDeepAgent` working.

### ✅ Phase 1 — Configurable LLM Switch
*Shipped. Status corrected 2026-09-02; the rationale below stands.*
**What:** `AGENT_MODEL` environment variable controls which LLM the agent uses.
**Why:** Use Gemini lite for quick tasks, Gemini pro for architecture decisions,
Ollama for offline development without burning API credits.
**New file:** `src/core/config/model-resolver.ts`

```bash
AGENT_MODEL=gemini-2.5-flash-lite      # default, fast and cheap
AGENT_MODEL=gemini-2.5-pro             # for architecture tasks
AGENT_MODEL=ollama:llama3.2            # local, no internet, free
AGENT_MODEL=anthropic:claude-opus-4-7  # maximum code quality
```

### ✅ Phase 2 — Researcher SubAgent
*Shipped. Status corrected 2026-09-02; the rationale below stands.*
**What:** Specialized subagent for reading and analyzing ONLY.
**Why:** Separation of concerns. The one who analyzes does not write.
Reduces "premature implementation before understanding the codebase" errors.
**New file:** `src/core/subagents/researcher.subagent.ts`

### ✅ Phase 3 — Coder SubAgent
*Shipped. Status corrected 2026-09-02; the rationale below stands.*
**What:** Subagent specialized in TDD — writes the spec BEFORE the implementation.
**Why:** The one who implements does not get distracted with analysis. Focus = code quality.
**New file:** `src/core/subagents/coder.subagent.ts`

### ✅ Phase 4 — Orchestrator
*Shipped. Status corrected 2026-09-02; the rationale below stands.*
**What:** Main agent that coordinates Researcher + Coder via the `task` tool.
**Why:** Replaces the old manual `StateGraph` with a smarter, more adaptive flow.
**Modification:** `DeepAgentFactory.createOrchestrator(config)`

### ✅ Phase 5 — Context Compression
*Shipped, but NOT as specified below. See the 2026-09-02 amendment: a first-party `ContextCompressor` replaced `createSummarizationMiddleware`.*
**What:** `createSummarizationMiddleware` from deepagents.
**Why:** For long tasks (e.g., refactoring an entire module), the context can fill up.
Compression automatically summarizes old messages to free up tokens.

### ✅ Phase 6 — Event Streaming (SSE)
*Shipped. Status corrected 2026-09-02; the rationale below stands.*
**What:** `POST /agent/stream` in NestJS returning `text/event-stream`.
**Why:** Allows integrating the agent into a web app or dashboard with real-time progress.

### ⏳ Phase 7 — Skills System
**What:** Package agent strategies as reusable `SKILL.md` files.
**Why:** Distribute and reuse "how to do DDD in NestJS" across multiple projects.

---

## Key Concepts Glossary

### What is a SubAgent?
A SubAgent is an agent running INSIDE another agent, invoked by the `task` tool.
Think of it as a specialized employee that your main agent can hire for specific tasks.

```
Orchestrator (the boss):
  "I need to analyze the codebase" → task(researcher) → waits for result
  "I need to implement X"          → task(coder)      → waits for result
```

### What is a Harness Profile?
deepagents' system for customizing agent behavior per LLM model. You can:
- Exclude incompatible tools (`excludedTools`)
- Add instructions to the system prompt (`systemPromptSuffix`)
- Override tool descriptions (`toolDescriptionOverrides`)

Key: the profile key must match the exact model string (e.g., `"gemini-2.5-flash-lite"`),
not a generic provider name (e.g., `"google"`).

### What is Context Compression?
When an agent works on long tasks, the message history grows. Compression takes the
oldest messages and summarizes them into a compact block, freeing tokens to continue
working without losing the overall context.

### What is SafeFilesystemBackend?
A wrapper over filesystem operations that creates automatic backups before every write.
If the agent writes bad code, you can restore. Lives in `src/core/agent/safe-backend.ts`.

### What is a Harness Profile Key?
deepagents resolves harness profiles using this lookup order (from `index.cjs` line 7940):
1. Exact match on the model string: `"gemini-2.5-flash-lite"` → looks up `"gemini-2.5-flash-lite"`
2. Provider prefix (only when model has a colon): `"anthropic:claude"` → looks up `"anthropic"`
3. No match → uses `EMPTY_HARNESS_PROFILE` (no customizations)

---

## Target Folder Structure

> **Amended 2026-09-02.** This is the *originally planned* tree and is kept as
> that record. The ⏳ markers inside it are stale — only `src/skills/` is still
> pending. The real tree has 125 source files and whole directories this block
> never anticipated (`core/agent/delegation/`, `core/security/`, `core/state/`,
> `core/llm/`, `core/observability/`). See the amendment at the top.

```
src/
├── bin/
│   └── cli.ts                      # Commands: deep, orchestrate, classic
├── core/
│   ├── agent/
│   │   ├── factory.ts              # 🏛️ museum — classic ReAct
│   │   ├── graph-factory.ts        # 🏛️ museum — StateGraph
│   │   ├── deep-agent-factory.ts   # ⭐ active — createDeepAgent
│   │   └── safe-backend.ts         # backup engine
│   ├── config/
│   │   └── model-resolver.ts       # ⏳ Phase 1 — LLM switch
│   ├── subagents/
│   │   ├── researcher.subagent.ts  # ⏳ Phase 2
│   │   └── coder.subagent.ts       # ⏳ Phase 3
│   ├── rag/
│   │   └── indexer.ts
│   ├── tools/
│   │   └── index.ts
│   └── interaction/
│       └── index.ts
├── presentation/                   # ⏳ Phase 6 — SSE API
│   ├── agent.controller.ts
│   ├── agent.module.ts
│   └── dtos/
│       └── agent-request.dto.ts
└── skills/                         # ⏳ Phase 7
    ├── nestjs-ddd-researcher/
    │   └── SKILL.md
    └── nestjs-tdd-coder/
        └── SKILL.md
```
