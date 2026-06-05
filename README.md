# NestJS AI Agent Lib

[![NestJS AI Agent](https://img.shields.io/badge/NestJS%20AI%20Agent-Lib-blue?style=flat-square)](https://github.com/your-repo/nestjs-ai-agent-lib)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](https://opensource.org/licenses/MIT)

> Built with â¤ï¸ by **David Balladares** â€” Principal Software Engineer level autonomous agent for NestJS.

An autonomous AI agent framework designed specifically for **NestJS** projects. It analyzes, plans, writes, and verifies code with specialized subagents, all accessible via a premium streaming CLI. Leverages **Google Gemini (Vertex AI)** or **local Ollama** models without requiring API keys for local inference.

---

## Table of Contents

- [Overview](#overview)
- [Key Features](#key-features)
- [Getting Started with NestJS](#getting-started-with-nestjs)
  - [Option A â€” Ollama (Local, Free, No API Key)](#option-a--ollama-local-free-no-api-key-)
  - [Option B â€” Google Gemini (Cloud)](#option-b--google-gemini-cloud)
- [CLI â€” Interactive Streaming Sessions](#cli--interactive-streaming-sessions)
  - [Session Management](#session-management)
  - [Switching Models â€” `/model` command](#switching-models---model-command)
  - [LLM Switching via env var](#llm-switching-via-env-var)
- [Agent Modes](#agent-modes)
  - [Deep Agent (`deep`)](#deep-agent-deep)
  - [Orchestrator (`orchestrate`)](#orchestrator-orchestrate)
- [Architecture](#architecture)
- [Core Concepts](#core-concepts)
  - [NestJS Integration](#nestjs-integration)
  - [Safety Features](#safety-features)
  - [RAG X-Ray Strategy](#rag-x-ray-strategy)
- [Project Structure](#project-structure)
- [Roadmap](#roadmap)
- [License](#license)

---

## Overview

This library empowers your NestJS applications with an autonomous AI agent capable of:

- ðŸ“‹ **Intelligent Planning:** Classifies task complexity (SMALL/MEDIUM/LARGE) and plans execution accordingly.
- ðŸ” **Codebase Analysis:** Performs semantic search over your project using Retrieval-Augmented Generation (RAG) for deep understanding (X-Ray strategy).
- ðŸ’¾ **Safe Code Writing:** Writes code with automatic backups before every file modification.
- ðŸ§ª **Automated Testing:** Integrates with Jest and `tsc --noEmit` for TDD, self-correcting on failures.
- ðŸ¤– **Subagent Delegation:** Spawns specialized "Researcher" and "Coder" subagents for complex tasks.
- âœ‹ **Human-in-the-Loop (HITL):** Prompts for approval on critical operations like file deletion or infrastructure changes.
- ðŸ’¬ **Persistent Memory:** Maintains full conversation history via SQLite, enabling continuation across named sessions.
- ðŸ§  **Context Compression:** Automatically summarizes long conversations to prevent context overflow.
- ðŸŽ¨ **Beautiful Output:** Renders responses in markdown with rich formatting (chalk, icons, code blocks).
- ðŸ” **Autonomous Execution:** Executes full plans without requiring manual `yes/no` confirmations.
- ðŸ©¹ **Self-Healing:** Recovers automatically from corrupted session states.
- ðŸ¦™ **Local LLM Support:** Full integration with Ollama, allowing use of models like Gemma4, Qwen3.6, Llama3.2 locallyâ€”free, offline, and no API key needed.

---

## Key Features

*   **NestJS Native:** Designed from the ground up for NestJS projects.
*   **Domain-Driven Design (DDD) Support:** Understands and can generate code following DDD principles.
*   **Architecture Aware:** Can analyze and refactor code while respecting architectural boundaries.
*   **TDD Workflow:** Integrates seamlessly with Jest for Test-Driven Development.
*   **Multiple LLM Backends:** Supports Google Gemini (cloud) and Ollama (local).
*   **Codebase Indexing (RAG):** Enables the agent to understand your project's structure and code through semantic search.
*   **Safety First:** Robust file system safety, HITL approvals for destructive actions.
*   **Efficient CLI:** Real-time token streaming and interactive model switching.
*   **Skills System (v1.4):** 12 keyword-triggered skills â€” the agent automatically loads the right guide for every task (DDD module, tests, refactor, security audit, architecture validation, and more). Base prompt stays lean regardless of how many skills exist.
*   **Mentor Mode (v1.4):** Always-on lightweight mentoring (root cause + trade-off on every response) plus a deep `/mentor` toggle for Socratic dialogue, Forced Output Contract, and architectural decision explanations.
*   **AGENTS.md Context Tiering (v1.4):** Separate context files â€” `ANTIGRAVITY.md` for the human, `AGENTS.md` for the agent â€” following OpenHands Context Tiering best practice.

---

## Getting Started with NestJS

### Option A â€” Ollama (Local, Free, No API Key) ðŸ¦™

The recommended and fastest way to start, running entirely on your machine.

**1. Install [Ollama](https://ollama.com) and pull a model:**

```bash
# Recommended model for a balance of quality and performance
ollama pull gemma4        # ~10 GB

# Or, for faster inference with lower RAM usage:
ollama pull gemma4:e2b    # ~7 GB

# Or, for strong reasoning with a compact model:
ollama pull qwen3.6       # ~4 GB
```

**2. Install project dependencies:**

```bash
npm install
```

**3. Configure your environment variables:**

Create a `.env.development` file in the project root:

```dotenv
# .env.development

# Use the model you pulled with Ollama
AGENT_MODEL=ollama:gemma4

# Optional: Only if Ollama runs on a non-default port (e.g., 11434)
# OLLAMA_BASE_URL=http://localhost:11434
```

**4. Run the agent:**

```bash
npm run agent -- deep
```

That's it! No Google account or API key needed.

> **Tip:** Inside the agent session, type `/model` to interactively switch between Ollama models or even to Gemini cloud models if you configure them.

---

### Option B â€” Google Gemini (Cloud)

Leverages Google's powerful Vertex AI models. Requires authentication.

#### Option B1 â€” Your personal Google account (Recommended for local development) âœ…

```bash
# 1. Install the Google Cloud SDK: https://cloud.google.com/sdk/docs/install
# 2. Authenticate and set your GCP project:
gcloud auth application-default login --project YOUR_GCP_PROJECT_ID

# 3. Configure your environment variables:
# Create or update .env.development:
# AGENT_MODEL=gemini-2.5-flash-lite

# 4. Run the agent:
npm run agent -- deep
```

#### Option B2 â€” Service Account (CI/CD, Production)

**Required IAM Role:**
*   `roles/aiplatform.user` (Vertex AI User)

Assign this role to your service account in the GCP Console: **IAM & Admin â†’ IAM â†’ Grant Access**.

```dotenv
# .env.development
# Path to your service account key file
GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/your/service-account.json

# Choose your Gemini model
AGENT_MODEL=gemini-2.5-flash-lite
```

---

## CLI â€” Interactive Streaming Sessions

The agent provides an interactive CLI experience similar to other advanced chatbots, with real-time token streaming and clear status indicators for tool execution.

```
â•­â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â•®
â”‚                                                â”‚
â”‚  NestJS AI Agent â€” Deep Mode                  â”‚
â”‚  Single autonomous agent with planning tools  â”‚
â”‚  Model: ollama:gemma4                         â”‚
â”‚  Session: auth-module (continuing)            â”‚
â”‚  Type your task. Ctrl+C to exit.              â”‚
â”‚                                                â”‚
â•°â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â•¯

You: Create a UsersModule following DDD principles.

  â ‹  Thinking...
â•­â”€ ðŸ“‹  write_todos
â”‚  â””â”€ Creating implementation plan...
â•°â”€ âœ“  done in 1.2s

â•­â”€ ðŸ”  ask_codebase
â”‚  â””â”€ How is AuthModule structured for DDD?
â•°â”€ âœ“  done in 3.4s

Agent: I will create a UsersModule following the same DDD pattern as AuthModule...
       (tokens stream as they are generated)

â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

You: â–Œ
```

### Session Management

Manage conversation history and context using session IDs.

| Command                                 | Behavior                                                              |
| :-------------------------------------- | :-------------------------------------------------------------------- |
| `npm run agent -- deep`                 | **Ephemeral** â€” Starts a fresh session each time.                     |
| `npm run agent -- deep --session auth`  | **Persistent** â€” Reopens or creates the `auth` session context.       |
| `npm run agent -- orchestrate --session feature-x` | Same persistence for the orchestrator mode.                         |
| `npm run agent -- deep "Your task"`     | Starts an ephemeral session with an initial human message.            |
| `npm run agent -- deep --session session-name "Your task"` | Starts/resumes a named session with an initial message. |

> **Note:** Session data is stored in `.agent/deep_agent_history.db` and `.agent/orchestrator_history.db`.

---

### Switching Models â€” `/model` command

Interact with the agent and switch LLM models on-the-fly without losing your current session context.

```
You: /model

â•­â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â•®
â”‚  ðŸ”§  Switch LLM Model                              â”‚
â”‚  Type the number and press Enter.                  â”‚
â”‚  Press 0 or Enter to cancel.                       â”‚
â•°â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â•¯

  Select Provider:
  1. âš¡  Vertex AI  (Gemini cloud â€” requires Google credentials)
  2. ðŸ¦™  Ollama     (Local models â€” free, no API key needed)  â† active
  Provider: 2

  Detecting Ollama models... âœ“ (4 found)

  Select Ollama Model:
  1. gemma4:26b  (17 GB)
  2. gemma4:e2b  (7.2 GB)
  3. gemma4:e4b  (9.6 GB)
  4. gemma4      (9.6 GB)
  Model: 1

  âœ… Switching to ollama:gemma4:26b
  ðŸ’¾ Saved to .env
  ðŸ”„ Restarting agent with new model...
```

The selected model is automatically saved to your `.env` file for future sessions.

### Slash Commands

| Command | Description | State |
|---|---|---|
| `/model` | Switch the active LLM model interactively (Ollama or Vertex AI) | â€” |
| `/mentor` | Toggle deep mentor mode â€” Forced Output Contract, trade-off analysis, Socratic gates | `[ON]` / `[OFF]` |
| `/help` | Show all available slash commands with their current state | â€” |
| `Ctrl+C` | Exit the session cleanly | â€” |

#### Mentor Mode in depth

The agent operates with **two levels of mentoring**:

**Level 1 â€” Always ON (built into the base prompt)**
Every fix, implementation, or architectural decision includes:
- **Root Cause** â€” why it broke (not just what)
- **Why this approach** â€” rationale over alternatives for significant decisions
- **Trade-off** â€” what's accepted or limited

For changes touching >5 files or public API contracts, the agent pauses and uses `ask_human` before implementing.

**Level 2 â€” `/mentor` deep mode**
Type `/mentor` to activate the full `skills/mentor-mode.md`:
- **Forced Output Contract** â€” explicit rationale + trade-offs before every code block
- **Architectural Escalation Gate** â€” presents alternatives rejected and why
- **Ask-Before HITL Gate** â€” confirms plan before big changes
- **Socratic Check** â€” asks if you want to go deeper before implementing concepts
- **Pattern Name Callout** â€” names the design pattern being applied (Repository, DDD, CQRS, etc.)

Type `/mentor` again to return to standard mode. The always-on Level 1 mentor remains active.

Type `mentor`, `teach me`, `explain why`, or `trade-off` naturally in a message to auto-trigger mentor mode via Progressive Disclosure.

---

### LLM Switching via env var

Alternatively, set the `AGENT_MODEL` environment variable before running the agent.

```powershell
# Windows PowerShell

# â”€â”€ Ollama (local, free) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Balanced quality/performance
$env:AGENT_MODEL="ollama:gemma4";       npm run agent -- deep

# Fast, low RAM
$env:AGENT_MODEL="ollama:gemma4:e2b";   npm run agent -- deep

# High quality (large download)
$env:AGENT_MODEL="ollama:gemma4:26b";   npm run agent -- deep

# Strong reasoning, compact
$env:AGENT_MODEL="ollama:qwen3.6";      npm run agent -- deep

# General purpose offline
$env:AGENT_MODEL="ollama:llama3.2";     npm run agent -- deep

# â”€â”€ Vertex AI (cloud) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Fast & cheap (default if no GOOGLE_APPLICATION_CREDENTIALS)
$env:AGENT_MODEL="gemini-2.5-flash-lite"; npm run agent -- deep

# Balanced speed + quality
$env:AGENT_MODEL="gemini-2.5-flash";      npm run agent -- deep

# Max capability (architecture, complex refactors)
$env:AGENT_MODEL="gemini-2.5-pro";        npm run agent -- orchestrate
```

```bash
# Linux / macOS
# Ollama examples
AGENT_MODEL=ollama:gemma4 npm run agent -- deep
AGENT_MODEL=ollama:qwen3.6 npm run agent -- deep

# Gemini examples
AGENT_MODEL=gemini-2.5-flash-lite npm run agent -- deep
AGENT_MODEL=gemini-2.5-pro npm run agent -- orchestrate
```

**Available Model Tiers:**

| Tier Alias | Model String             | Provider   | Best For                               |
| :--------- | :----------------------- | :--------- | :------------------------------------- |
| `gemma`    | `ollama:gemma4`          | ðŸ¦™ Local    | Best local model for general coding    |
| `gemma-2b` | `ollama:gemma4:e2b`      | ðŸ¦™ Local    | Fast, low RAM (~7 GB)                  |
| `gemma-4b` | `ollama:gemma4:e4b`      | ðŸ¦™ Local    | Balance speed/quality (~9.6 GB)        |
| `gemma-26b`| `ollama:gemma4:26b`      | ðŸ¦™ Local    | Max quality (~17 GB)                   |
| `qwen`     | `ollama:qwen3.6`         | ðŸ¦™ Local    | Strong reasoning, compact (~4 GB)      |
| `local`    | `ollama:llama3.2`        | ðŸ¦™ Local    | General purpose offline                |
| `lite`     | `gemini-3.1-flash-lite`  | âš¡ Cloud    | Quick edits, Q&A (cheapest)           |
| `flash`    | `gemini-3.5-flash`       | âš¡ Cloud    | Balanced speed + quality (recommended) |
| `pro`      | `gemini-3.1-pro`         | âš¡ Cloud    | Architecture, complex refactors        |

> **Embeddings Note:** For Retrieval-Augmented Generation (RAG), the agent consistently uses **Vertex AI's `text-embedding-004`** model, regardless of the chat model selected. This ensures a stable and high-quality codebase index even when switching between local Ollama and cloud Gemini models.

---

## Agent Modes

### Deep Agent (`deep`) â€” Single Autonomous Agent

Ideal for most day-to-day tasks: debugging, code analysis, single-file modifications, quick questions, and medium-complexity features.

```bash
# Start an ephemeral session
npm run agent -- deep

# Start a persistent session named "my-feature"
npm run agent -- deep --session my-feature

# Ask a specific question about a file
npm run agent -- deep "explain src/core/agent/deep-agent-factory.ts"
```

**Task Sizing:** The agent automatically classifies tasks before execution:
*   **SMALL:** (1-2 files, straightforward changes) â†’ Executes directly (Read â†’ Write â†’ Done). Max 3 tool calls.
*   **MEDIUM:** (3+ files, new feature) â†’ Creates a brief `write_todos` plan and executes it.
*   **LARGE:** (Entire module, major refactor) â†’ Follows a detailed, step-by-step plan using `write_todos`.

**Core Tools:**
*   `write_todos`: Plans and tracks multi-step tasks.
*   `list_files`: Lists directory contents.
*   `safe_read_file`: Reads file content safely.
*   `safe_write_file`: Writes to files with automatic backups.
*   `ask_codebase`: Performs semantic search over your codebase using RAG.
*   `refresh_project_index`: Rebuilds the RAG index (e.g., after bulk file writes).
*   `run_integrity_check`: Runs `tsc --noEmit` to ensure type safety.
*   `run_tests`: Executes Jest test suites.

---

### Orchestrator (`orchestrate`) â€” Multi-SubAgent Coordinator

Best suited for complex, large-scale tasks such as implementing entire modules, significant refactoring efforts, or adding major features that span multiple files and components.

```bash
# Start an ephemeral orchestrator session
npm run agent -- orchestrate

# Start a persistent session for a major refactor
npm run agent -- orchestrate --session big-refactor
```

**Mandatory Workflow:** The orchestrator strictly follows a predefined protocol to ensure thoroughness and quality:
1.  **`write_todos`:** Creates a comprehensive plan covering analysis, implementation, and verification.
2.  **`task(researcher)`:** Delegates analysis to the `researcher` subagent, which examines the codebase and produces a detailed implementation plan.
3.  **`task(coder)`:** Delegates implementation to the `coder` subagent, which follows the researcher's plan, adheres to Test-Driven Development (TDD), and writes tests *before* implementation.
4.  **`run_integrity_check`:** Verifies that the entire project is free of TypeScript errors after the `coder` finishes.

**Subagents:**
*   **Researcher:** A read-only analyst. Uses tools like `ask_codebase` and `safe_read_file` to understand the project and generate structured plans.
*   **Coder:** An implementation specialist. Uses `safe_write_file`, `run_tests`, and `run_integrity_check`. Writes `.spec.ts` files first, then implements the corresponding code. Self-corrects up to 3 times upon test failures.

---

## Architecture

\`\`\`mermaid
graph TD
    subgraph CLI Interface
        A[Interactive Stream]:::cli --> B(Session Management);
        B --> C[/model Command];
        B --> D[Model Switching Logic];
        B --> E[Agent Mode Selection];
    end

    subgraph Agent Core
        E --> F(DeepAgentFactory);
        F --> G[LLMProvider];
        G -- Ollama --> H(OllamaChatAdapter);
        G -- Gemini --> I(ChatVertexAI);
        F -- Simple Agent --> J(createDeepAgent);
        F -- Orchestrator --> K(createDeepAgent);
        K --> L[Researcher Subagent];
        K --> M[Coder Subagent];
    end

    subgraph Services & Tools
        J --> N(Core Tools);
        K --> N;
        N --> O(SafeFilesystemBackend);
        N --> P(RAG IndexerService);
        N --> Q(Checkpointer SqliteSaver);
        J --> Q;
        K --> Q;
    end

    classDef cli fill:#4CAF50,stroke:#333,stroke-width:2px;
    classDef session fill:#FFC107,stroke:#333,stroke-width:2px;
    classDef modelcmd fill:#2196F3,stroke:#333,stroke-width:2px;
    classDef mode fill:#FF9800,stroke:#333,stroke-width:2px;
    classDef factory fill:#9C27B0,stroke:#333,stroke-width:2px;
    classDef subagent fill:#00BCD4,stroke:#333,stroke-width:2px;

    class A cli;
    class B session;
    class C modelcmd;
    class E mode;
    class F factory;
    class L,M subagent;
\`\`\`

*   **CLI:** Handles user interaction, model switching (`/model`), and session management.
*   **Agent Core:** `DeepAgentFactory` orchestrates agent creation, routing requests to either a simple `DeepAgent` or a multi-subagent `Orchestrator`.
*   **LLM Integration:** `LLMProvider` routes requests to `OllamaChatAdapter` for local models or `ChatVertexAI` for cloud models.
*   **Services & Tools:** Provides core functionalities like safe file operations, RAG indexing, conversation persistence (SQLite), and the underlying LLM tooling.

---

## Core Concepts

### NestJS Integration

This library is built with NestJS in mind. It understands NestJS conventions for project structure, modules, services, controllers, and DDD. When you ask the agent to perform tasks like "create a user module" or "add authentication to this service," it leverages its knowledge of NestJS patterns to generate appropriate, idiomatic code.

### Safety Features

*   **`safe_write_file`:** Before writing any file, the agent creates a timestamped backup in `.agent/backups/`. This ensures you can always revert to the previous version if the agent's changes are not as expected.
*   **Project Root Sandboxing:** The agent operates strictly within the project's root directory. It cannot access or modify files outside this scope.
*   **Human-in-the-Loop (HITL):** For potentially destructive operations (e.g., deleting files/directories, dropping database tables, modifying infrastructure files like `docker-compose.yml` or `.env.production`), the agent will pause and explicitly ask for your approval.

### RAG X-Ray Strategy

The agent uses Retrieval-Augmented Generation (RAG) to understand your codebase:
1.  **Indexing:** The `IndexerService` scans your `src/` directory on startup. This index is lazily updatedâ€”it only rebuilds if it's older than 5 minutes, ensuring fast agent startup times.
2.  **Semantic Search:** When you ask questions about your code, the `ask_codebase` tool performs a vector similarity search against the index.
3.  **Contextual Understanding:** The search results provide relevant code snippets and dependency information, giving the LLM a deep understanding of your project's structure and logic.

*   **Ollama Mode:** If you're using Ollama without Google Cloud credentials, RAG indexing is gracefully skipped. The agent will still function but without the codebase-aware semantic search capabilities.

---

## Project Structure

The library follows a clean, modular structure:

```
/nestjs-ai-agent-lib
â”œâ”€â”€ src/
â”‚   â”œâ”€â”€ bin/                      # CLI entry points (deep, orchestrate)
â”‚   â”‚   â””â”€â”€ cli.ts
â”‚   â”œâ”€â”€ core/                     # Core agent logic & services
â”‚   â”‚   â”œâ”€â”€ agent/                # Agent factories (DeepAgentFactory)
â”‚   â”‚   â”‚   â”œâ”€â”€ factory.ts        # Legacy ReAct agent
â”‚   â”‚   â”‚   â”œâ”€â”€ graph-factory.ts  # Legacy StateGraph agent
â”‚   â”‚   â”‚   â””â”€â”€ deep-agent-factory.ts  # â­ Active: Creates DeepAgent & Orchestrator
â”‚   â”‚   â”œâ”€â”€ config/               # Configuration loading (env vars, model resolution)
â”‚   â”‚   â”‚   â”œâ”€â”€ model-resolver.ts
â”‚   â”‚   â”‚   â””â”€â”€ model-switcher.ts
â”‚   â”‚   â”œâ”€â”€ llm/                  # LLM provider routing & adapters
â”‚   â”‚   â”‚   â”œâ”€â”€ provider.ts
â”‚   â”‚   â”‚   â””â”€â”€ ollama-adapter.ts # Handles Ollama's specific API requirements
â”‚   â”‚   â”œâ”€â”€ subagents/            # Specialized agents for orchestration
â”‚   â”‚   â”‚   â”œâ”€â”€ coder.subagent.ts
â”‚   â”‚   â”‚   â””â”€â”€ researcher.subagent.ts
â”‚   â”‚   â”œâ”€â”€ rag/                  # Retrieval-Augmented Generation
â”‚   â”‚   â”‚   â””â”€â”€ indexer.ts        # Codebase indexing service
â”‚   â”‚   â””â”€â”€ tools/                # Custom tool implementations (safe file ops, etc.)
â”‚   â”‚       â””â”€â”€ index.ts
â”‚   â”œâ”€â”€ presentation/             # CLI UI and presentation logic
â”‚   â”‚   â”œâ”€â”€ cli/
â”‚   â”‚   â”‚   â”œâ”€â”€ chat-session.ts   # Main interactive loop + slash command dispatcher
â”‚   â”‚   â”‚   â”œâ”€â”€ model-menu.ts     # Interactive model selection UI
â”‚   â”‚   â”‚   â”œâ”€â”€ stream-renderer.ts # Output formatting (tokens, tools, Agent header)
â”‚   â”‚   â”‚   â”œâ”€â”€ markdown-renderer.ts # Markdown â†’ chalk styled terminal output
â”‚   â”‚   â”‚   â””â”€â”€ theme.ts          # CLI styling and icons
â”‚   â”‚   â””â”€â”€ index.ts
â”œâ”€â”€ skills/                       # â­ Agent skills â€” keyword-triggered, read-only
â”‚   â”œâ”€â”€ create-ddd-module.md      # DDD module creation protocol
â”‚   â”œâ”€â”€ write-tests.md            # TDD & Jest spec templates
â”‚   â”œâ”€â”€ refactor-safely.md        # Inside-out refactor, find callers first
â”‚   â”œâ”€â”€ create-endpoint.md        # REST endpoint + DTO + Swagger
â”‚   â”œâ”€â”€ debug-typescript.md       # TS error lookup table & fix protocol
â”‚   â”œâ”€â”€ analyze-codebase.md       # Read-only RAG analysis mode
â”‚   â”œâ”€â”€ evaluate-own-work.md      # Self-review checklist before "done"
â”‚   â”œâ”€â”€ git-workflow.md           # Conventional commits & version branching
â”‚   â”œâ”€â”€ security-audit.md         # OWASP API Top 10 for NestJS
â”‚   â”œâ”€â”€ research-output-format.md # Structured Researcherâ†’Coder handoff (MetaGPT SOP)
â”‚   â”œâ”€â”€ validate-architecture-boundaries.md  # DDD forbidden import detector
â”‚   â””â”€â”€ mentor-mode.md            # Deep mentor: Forced Output Contract + Socratic gates
â”œâ”€â”€ AGENTS.md                     # â­ Project context for AI agents (read-only)
â”œâ”€â”€ ANTIGRAVITY.md                # ADR log & work history for the human developer
â”œâ”€â”€ .agent/                       # Agent runtime data
â”‚   â”œâ”€â”€ deep_agent_history.db     # SQLite DB for named deep agent sessions
â”‚   â”œâ”€â”€ orchestrator_history.db   # SQLite DB for named orchestrator sessions
â”‚   â”œâ”€â”€ index.meta.json           # Timestamp for RAG index freshness
â”‚   â””â”€â”€ backups/                  # Timestamped backups before each file write
â”œâ”€â”€ .env.development              # Example environment file
â”œâ”€â”€ package.json
â””â”€â”€ tsconfig.json
```

---

## Roadmap

| Phase | Feature | Status |
|---|---|---|
| **v1.0** | Foundational Deep Agent (`deep` mode) | âœ… Done |
|   | Basic LLM switching (env var) | âœ… Done |
|   | Core tools (filesystem, RAG basic) | âœ… Done |
| **v1.1** | Orchestrator (`orchestrate` mode) | âœ… Done |
|   | Researcher & Coder subagents | âœ… Done |
|   | TDD workflow enforcement | âœ… Done |
| **v1.2** | Advanced CLI Features | âœ… Done |
|   | Interactive `/model` switching | âœ… Done |
|   | Session persistence & management | âœ… Done |
|   | Context compression | âœ… Done |
|   | Safety: Auto-recovery, HITL | âœ… Done |
| **v1.3** | **Ollama Local Inference Support** | âœ… **Done** |
|   | Full multi-provider routing | âœ… Done |
|   | `OllamaChatAdapter` for compatibility | âœ… Done |
|   | Support for `gemma4`, `qwen3.6`, `llama3.2` | âœ… Done |
| **v1.4** | **Skills System & Mentor Mode** | âœ… **Done** |
|   | 12 keyword-triggered skills (`skills/*.md`) | âœ… Done |
|   | Progressive Disclosure â€” keyword map in base prompt | âœ… Done |
|   | FILE PROTECTION LAW (skills + ANTIGRAVITY + AGENTS.md) | âœ… Done |
|   | `AGENTS.md` Context Tiering (agent vs. human save state) | âœ… Done |
|   | Always-on lightweight mentor (base prompt invariant) | âœ… Done |
|   | `/mentor` deep mode (Forced Output Contract + Socratic gates) | âœ… Done |
|   | Structured Researcherâ†’Coder handoff (`research-output-format.md`) | âœ… Done |
|   | DDD layer boundary validator (`validate-architecture-boundaries.md`) | âœ… Done |
| **v1.4.2** | **Stability & CLI Polish** | âœ… **Done** |
|   | Bug: `MODEL_TIERS` expansion â€” `resolveModel()` never used tiers (silent crash) | âœ… Fixed |
|   | Bug: Fake Anthropic â€” `claude` removed from tiers, honest error on unsupported provider | âœ… Fixed |
|   | Bug: Phase 2 proactive auto-compression â€” `checkAndCompressContext()` after every turn | âœ… Fixed |
|   | Bug: `reflect-metadata` CLI crash â€” removed dead `@Injectable()` from 3 services | âœ… Fixed |
|   | CLI: Richer markdown renderer â€” code blocks with full `â•­â”€â”€â•®` borders, header icons (`â˜…`, `â—ˆ`, `â€º`), 2-space global indent | âœ… Done |
|   | CLI: `â¬¡ Agent â”€â”€â”€â”€` header replaces plain `Agent:` label | âœ… Done |
| **v1.5.0** | **LangSmith Observability** | ✅ **Done** |
|   | langsmith SDK integration via auto-instrumentation | ✅ Done |
|   | Zero-code tracing: all LLM calls, tool calls, LangGraph steps | ✅ Done |
|   | Configure with 3 env vars: LANGCHAIN_TRACING_V2, LANGCHAIN_API_KEY, LANGCHAIN_PROJECT | ✅ Done |
|   | No-op when env vars are absent (safe for library consumers) | ✅ Done |
| **Future** | SSE HTTP API (`/agent/stream`) | â³ Planned |
|   | Agent self-evolution â€” write new skills from patterns it discovers | â³ Planned |
|   | Anthropic Claude support (`@langchain/anthropic`) | â³ Planned |
|   | LangGraph state-level mentor toggle (true per-session stateful mode) | â³ Planned |

---

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

