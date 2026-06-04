# NestJS AI Agent Lib

An AI-powered autonomous agent framework for NestJS applications, designed for sophisticated code analysis, understanding, modification, and orchestration. Built for Principal Software Engineer level tasks using advanced RAG, Multi-Agent architecture, and robust safety protocols.

## Table of Contents

*   [Overview](#overview)
*   [Getting Started](#getting-started)
*   [Core Concepts](#core-concepts)
    *   [DeepAgentFactory](#deepagentfactory)
    *   [RAG Strategy (X-Ray)](#rag-strategy-x-ray)
    *   [Development Standards](#development-standards)
    *   [Security & Persistence](#security--persistence)
*   [Command Line Interface (CLI)](#command-line-interface-cli)
*   [Project Structure](#project-structure)
*   [Cost Tracking & Usage Metrics](#cost-tracking--usage-metrics)
*   [Roadmap](#roadmap)
*   [Contributing](#contributing)
*   [License](#license)

---

## Overview

The NestJS AI Agent Lib empowers developers to automate complex coding tasks within their NestJS projects. It leverages a combination of Large Language Models (LLMs), Retrieval-Augmented Generation (RAG), and a flexible multi-agent system to provide intelligent code assistance. From refactoring and bug fixing to generating new modules, the agent operates with a strong emphasis on code quality, safety, and adherence to project standards.

---

## Getting Started

### 1. Installation

Install the package via npm:

```bash
npm install @dastbal/nestjs-ai-agent
```

### 2. Configuration

Create a `.env` file in your project root with your API credentials. The agent supports dynamic model switching (via `model-resolver.ts`), prioritizing the `AGENT_MODEL` environment variable.

```dotenv
# API Keys (Required for Google models)
GEMINI_API_KEY="your-api-key"

# Model Selection (Optional - overrides default)
# Example: AGENT_MODEL="gemini-2.5-pro"
AGENT_MODEL="gemini-2.5-flash-lite"
```

### 3. Usage

Import the module into your `app.module.ts`:

```typescript
import { AiAgentModule } from '@dastbal/nestjs-ai-agent';

@Module({
  imports: [AiAgentModule.forRoot()],
})
export class AppModule {}
```

---

## Core Concepts

### DeepAgentFactory

The `DeepAgentFactory` is the central orchestrator for creating and configuring AI agents. It offers two primary factory methods:

*   **`DeepAgentFactory.create(config, interaction)`**:
    *   Initializes a **simple, single-agent** instance.
    *   Ideal for straightforward tasks, quick code modifications, and direct Q&A sessions.
    *   Includes core tools: filesystem access (`safe_write_file`, `safe_read_file`), RAG search (`ask_codebase`), planning (`write_todos`), and validation (`run_integrity_check`).
    *   Uses isolated SQLite persistence for its conversation history.

*   **`DeepAgentFactory.createOrchestrator(config, interaction)`**:
    *   Initializes a **multi-subagent orchestrator**.
    *   Designed for complex features, new module generation, and architectural changes.
    *   Delegates tasks to specialized subagents (`researcher`, `coder`) via the `task` tool.
    *   Enforces a strict orchestration protocol: Plan → Research → Implement → Verify.
    *   Supports context compression for long-running tasks.
    *   Uses a separate SQLite database for its history to avoid conflicts with simple agents.

Both methods ensure proper project indexing (`IndexerService`), safe filesystem operations, and adherence to defined quality and safety standards.

### Multi-Agent Roles (Subagents)

When operating in Orchestrator mode, tasks are delegated to specialized subagents:

#### Supervisor Agent
*   **Role:** The central orchestrator. It manages the overall workflow, delegates tasks to specialized agents (Researcher, Coder), monitors progress, and coordinates their interactions.
*   **Key Files:** `src/core/agent/graph/supervisor.graph.ts`, `src/core/agent/supervisor.service.ts`

#### Researcher Agent
*   **Role:** The intelligence gatherer. It specializes in analyzing the codebase, understanding its structure, identifying dependencies, and retrieving relevant information using RAG.
*   **Key Files:** `src/core/agent/researcher.service.ts`, `src/core/rag/retriever.ts`, `src/core/tools/ast/chunker.ts`

#### Coder Agent
*   **Role:** The code manipulator. It is responsible for generating, modifying, and refactoring code based on the Researcher's analysis, applying strict development standards ('Surgeon's Rule', 'Golden Prompt').
*   **Key Files:** `src/core/agent/coder.service.ts`, `src/core/agent/graph/coder.graph.ts`

### Graph Flow

The interaction between agents is managed through graph-based execution (LangGraph), defining complex workflows as state machines:
1.  Supervisor receives a request.
2.  Supervisor delegates analysis to Researcher.
3.  Researcher performs analysis using RAG (X-Ray).
4.  Supervisor instructs Coder based on findings.
5.  Coder modifies code surgically.
6.  Supervisor confirms completion or initiates further steps.

### RAG Strategy (X-Ray)

The agent employs an advanced Retrieval-Augmented Generation (RAG) strategy, internally termed "X-Ray," for deep code understanding.

1.  **Code Indexing:** The codebase is scanned, parsed using Abstract Syntax Trees (ASTs), and broken down into meaningful code chunks. Structural dependencies are extracted to build a dependency graph.
    *   *Key Components:* `IndexerService`, `NestChunker`, AST parsing.
2.  **Semantic Search & Retrieval:** Queries are embedded and used to perform vector similarity searches against the indexed code chunks, retrieving the most relevant segments.
    *   *Key Components:* `Retriever.query()`, Vector Similarity Search.
3.  **Context Augmentation:** Retrieved code chunks are enriched with file dependencies, import graphs, and simplified file skeletons to provide rich contextual information for the LLM.
    *   *Key Components:* `Retriever.getContextForLLM()`, `getFileSkeleton()`, dependency analysis.
4.  **Report Generation:** All gathered information is compiled into a structured "RAG ANALYSIS REPORT," which serves as the primary input for the LLM, enabling informed analysis and code generation.

This "X-Ray" approach allows agents to deeply "see" and understand the codebase's structure, semantics, and relationships.

### Development Standards

#### Surgeon's Rule

The Coder agent strictly adheres to the "Surgeon's Rule" to ensure code modifications are precise, safe, and non-disruptive:

1.  **Read-Before-Write:** NEVER overwrite a file without first reading and thoroughly understanding its existing logic, TSDocs, dependencies, and context using `safe_read_file`.
2.  **Preservation First:** Do not delete existing TSDocs, comments, or unrelated business logic. Focus on augmenting and refining code surgically, avoiding unintended side effects.
3.  **Anti-Regression:** Understand the purpose of existing code before altering or removing it. Ensure that no functionality, especially edge-case handling, is lost. If unsure, research its purpose first.

#### Golden Prompt

Prompts are carefully crafted using the "Golden Prompt" principles to ensure clarity, context, and adherence to standards, guiding the AI to produce high-quality, relevant code.

### Security & Persistence

#### SafeFilesystemBackend

All filesystem operations are routed through `SafeFilesystemBackend`, which enforces critical safety measures:

*   **Sandboxing:** Operations are strictly confined to the project's root directory (`rootDir`) to prevent accidental modifications outside the intended scope.
*   **Backup System:** Before any file write operation (`safe_write_file`), an automatic backup of the original file is created in the `.agent/backups/` directory. This provides a rollback mechanism.
*   **Atomic Operations:** Designed to ensure that file writes are as atomic as possible, reducing the risk of corrupted files.

#### Human-in-the-Loop (HITL)

For critical operations or when safety protocols are triggered (e.g., after multiple failed self-corrections), the agent may pause and request explicit human approval before proceeding. This ensures that potentially risky code modifications are reviewed by a human.

---

## Command Line Interface (CLI)

Interact with the agent using the provided CLI commands.

### Basic Usage

The most common way to interact is by running the agent directly with a prompt:

```bash
# Start the main agent in a conversational mode
npm run agent "Explain the architecture of this project"
```

*(The first run of an agent type typically syncs and indexes your codebase for RAG context).*

### Advanced Commands

For more granular control and specific agent modes, use the `run` command with subcommands:

*   **`deep`**:
    *   Launches the primary, sophisticated `DeepAgentFactory` orchestrator.
    *   Ideal for complex, multi-step tasks requiring research, planning, and coding.
    *   Example: `npm run agent deep -- "Implement a caching layer using Redis"`

*   **`chat`**:
    *   Initiates a simpler, conversational agent mode.
    *   Suitable for quick questions, code explanations, or single-file modifications.
    *   Example: `npm run agent chat -- "What does this function do?"`

*   **`graph`**:
    *   Allows direct interaction with agents operating on a graph-based execution flow (e.g., using LangGraph).
    *   Useful for debugging or understanding specific agent state transitions.
    *   Example: `npm run agent graph -- "Trace the execution flow for the refactoring task"`

*   **`classic`**:
    *   Launches the older, simpler agent based on `AgentFactory`.
    *   May be used for backward compatibility or tasks not requiring the full power of `DeepAgentFactory`.
    *   Example: `npm run agent classic -- "Add a comment to calculateTotal function"`

---

## Project Structure

```text
.
├── src/
│   ├── core/
│   │   ├── agent/                 # Agent factory, supervisor, researcher, coder, etc.
│   │   ├── llm/                   # LLM provider configuration
│   │   ├── rag/                   # RAG indexing and retrieval logic
│   │   ├── state/                 # Persistence (SQLite) and DB abstraction
│   │   ├── interaction/           # CLI interaction, spinners, etc.
│   │   ├── tools/                 # Reusable agent tools (filesystem, codebase, etc.)
│   │   ├── config/                # Configuration resolvers (models, etc.)
│   │   └── subagents/             # Specialized subagents (e.g., researcher, coder)
│   ├── app.module.ts              # Main application module
│   └── main.ts                    # Application entry point
├── .agent/                        # Agent-specific data
│   ├── history.db                 # Default agent conversation history
│   ├── deep_agent_history.db      # Orchestrator conversation history
│   └── backups/                   # Backups for safe file operations
├── .env                           # Environment variables
├── README.md
├── tsconfig.json
└── package.json
```

---

## Cost Tracking & Usage Metrics

The library includes integrated, real-time cost tracking and token usage monitoring. Prices are configurable via `llm-pricing.json`, allowing for precise cost management and transparency. The system utilizes DDD Value Objects (`Money`, `TokenUsage`) for accurate calculations.

---

## Roadmap

- [x] **Phase 1: LLM Agnosticism:** Dynamic model switching via `.env` configured in `src/core/config/model-resolver.ts` (*Completed in commit `4d11081`*).
- [ ] **Phase 2: SubAgents:** Splitting responsibilities into specialized `Researcher` and `Coder` subagents orchestrated by the DeepAgent.
- [ ] **Phase 3: Web UI Interface:** Exposing a frontend dashboard to view the dependency graph and approve HITL actions visually.

---

## Contributing

Contributions are welcome! Please follow the development standards outlined in this README and submit a Pull Request. For major changes, please open an issue first to discuss the proposed changes.

---

## License

This project is licensed under the MIT License.
