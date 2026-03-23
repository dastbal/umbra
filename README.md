# NestJS AI Agent Project

This project implements an AI-powered agent system built with NestJS, designed to assist in code analysis, understanding, and modification. It leverages a multi-agent architecture, RAG (Retrieval-Augmented Generation) for code intelligence, and specific development standards to ensure code quality and maintainability.

## Table of Contents

1.  [Project Overview](#project-overview)
2.  [Architecture](#architecture)
    *   [Multi-Agent System](#multi-agent-system)
        *   [Supervisor Agent](#supervisor-agent)
        *   [Researcher Agent](#researcher-agent)
        *   [Coder Agent](#coder-agent)
    *   [RAG Discovery Strategy (X-Ray)](#rag-discovery-strategy-x-ray)
3.  [Development Standards](#development-standards)
    *   [Surgeon's Rule](#surgeons-rule)
    *   [Golden Prompt](#golden-prompt)
4.  [Persistence Strategy](#persistence-strategy)
    *   [Isolated SQLite Persistence](#isolated-sqlite-persistence)
5.  [Getting Started](#getting-started)
6.  [Project Structure](#project-structure)

## Project Overview

The NestJS AI Agent Project aims to provide an intelligent assistant capable of understanding, analyzing, and refactoring codebases. It employs advanced AI techniques, including RAG, and adheres to strict development principles to ensure robust and reliable performance.

## Architecture

### Multi-Agent System

The project utilizes a multi-agent architecture where specialized agents collaborate to achieve complex tasks. The core agents include:

#### Supervisor Agent

*   **Role:** The orchestrator of the system. It manages the overall workflow, delegates tasks to specialized agents (Researcher, Coder), and coordinates their execution. The Supervisor ensures that tasks are processed efficiently and that the agents work together cohesantly.
*   **Key Files:** `src/core/agent/graph/supervisor.graph.ts` (Defines the graph structure for task flow), `src/core/agent/supervisor.service.ts` (Core logic for task delegation and management).

#### Researcher Agent

*   **Role:** Responsible for code analysis, information retrieval, and understanding the codebase's structure and dependencies. It uses RAG techniques to query and analyze code, providing insights to other agents.
*   **Key Files:** `src/core/agent/researcher.service.ts`, `src/core/rag/retriever.ts` (Handles semantic search and context retrieval), `src/core/tools/ast/chunker.ts` (Parses code into ASTs for analysis).

#### Coder Agent

*   **Role:** Focuses on code generation, modification, and refactoring. It receives instructions, analyzes requirements (often informed by the Researcher), and applies development standards like the 'Surgeon's Rule' and 'Golden Prompt' to produce high-quality code.
*   **Key Files:** `src/core/agent/coder.service.ts`, `src/core/agent/graph/coder.graph.ts` (Defines the Coder's task execution graph).

### RAG Discovery Strategy (X-Ray)

The Researcher agent employs a RAG-based strategy, referred to as "X-Ray," for deep code analysis. This involves:

1.  **Code Indexing:** The codebase is parsed, and meaningful code segments (chunks) are extracted along with their structural dependencies (import relationships). This process generates embeddings for semantic search and builds a knowledge graph.
    *   **Key Files:** `src/core/rag/indexer.ts` (Manages the indexing pipeline), `src/core/tools/ast/chunker.ts` (Performs AST parsing and chunking).
2.  **Semantic Search:** When analyzing a query or a specific code section, the Researcher performs a semantic search against the indexed code embeddings to find relevant code snippets.
3.  **Context Augmentation:** The retrieved code snippets are enriched with structural information, such as file dependencies and code skeletons (class/method signatures). This provides a comprehensive context.
    *   **Key Files:** `src/core/rag/retriever.ts` (Implements the retrieval and context augmentation logic).
4.  **Report Generation:** A detailed "RAG ANALYSIS REPORT" is generated, summarizing the findings, including relevant code, dependencies, and structural information, which is then used by the LLM for decision-making or code generation.

This "X-Ray" approach allows the Researcher to gain a deep, context-aware understanding of the codebase.

## Development Standards

### Surgeon's Rule

The Coder agent adheres to the 'Surgeon's Rule', a set of principles ensuring code modifications are safe, precise, and maintainable. These rules are critical for preserving code integrity during refactoring and updates.

*   **Rule 1: Read-Before-Write:** Always analyze and understand the existing code and its context before making any modifications. This involves reading the relevant code sections, understanding their purpose, dependencies, and potential impact.
*   **Rule 2: Preservation First (Anti-Regression):** Prioritize preserving existing functionality and unrelated business logic. Changes should be minimal and targeted, avoiding unintended side effects. Comments, TSDocs, and existing structure should be maintained unless they are directly part of the refactoring task.
*   **Rule 3: Differential Analysis:** Focus on the specific changes being made. Understand the difference between the old and new code and ensure that only the intended modifications are implemented.

*   **Location:** These principles guide the Coder's actions and are documented in the Coder's prompt and potentially within `src/core/agent/coder.service.ts` or related graph definitions.

### Golden Prompt

The 'Golden Prompt' is a standard for crafting effective prompts for the AI models, particularly when instructing the Coder agent. It ensures clarity, specificity, and provides all necessary context for the AI to generate accurate and high-quality code. Key elements include:

*   **Clear Objective:** State the goal of the task precisely.
*   **Contextual Information:** Provide relevant background, existing code snippets, or architectural details.
*   **Constraints & Standards:** Specify any rules to follow (e.g., Surgeon's Rule, specific patterns, performance requirements).
*   **Expected Output:** Describe the desired format or structure of the generated code.

*   **Location:** This standard is applied when generating prompts for the Coder agent, often within the Supervisor or Coder's internal logic.

## Persistence Strategy

### Isolated SQLite Persistence

The project employs an isolated persistence strategy using SQLite databases, ensuring that each agent manages its own state and data independently.

*   **Mechanism:** Each agent (or a group of related agents) utilizes its own SQLite database file (e.g., `.agent/memory.db`).
*   **Data Stored:** These databases store agent-specific data, including:
    *   Code embeddings generated by the RAG process.
    *   Dependency graph information.
    *   Agent state and memory.
*   **Benefits:**
    *   **Isolation:** Prevents interference between agents' data, enhancing stability.
    *   **Modularity:** Allows agents to be developed and managed more independently.
    *   **Efficiency:** Localized data access can be faster for agent-specific operations.
*   **Key Files:** `src/core/state/db.ts` (Abstracts database interactions), `src/core/state/sqlite-saver.ts` (Specific implementation for SQLite persistence), `src/core/agent/factory.ts` (Where agent instances are created and potentially assigned their persistence stores).

## Getting Started

*(Instructions for setting up and running the project would go here.)*

## Project Structure

```
.
├── src/
│   ├── core/
│   │   ├── agent/
│   │   │   ├── graph/
│   │   │   │   ├── coder.graph.ts
│   │   │   │   └── supervisor.graph.ts
│   │   │   ├── coder.service.ts
│   │   │   ├── factory.ts             # Agent factory, persistence setup
│   │   │   ├── graph-factory.ts       # Graph agent instantiation
│   │   │   ├── index.ts               # Agent module exports
│   │   │   └── researcher.service.ts
│   │   ├── llm/
│   │   │   └── provider.ts            # LLM and embedding model configuration
│   │   ├── rag/
│   │   │   ├── indexer.ts             # RAG indexing logic
│   │   │   └── retriever.ts           # RAG retrieval and context augmentation
│   │   ├── state/
│   │   │   ├── agent-db.ts            # Database abstraction layer
│   │   │   ├── file-registry.ts       # File change tracking
│   │   │   └── sqlite-saver.ts        # SQLite persistence implementation
│   │   └── tools/
│   │       ├── ast/
│   │       │   └── chunker.ts         # Code parsing and chunking
│   │       ├── ask-codebase.tool.ts   # Tool for codebase queries
│   │       └── execute-command.tool.ts # Tool for executing shell commands (requires caution)
│   ├── interaction/
│   │   ├── interaction.service.ts     # Service for user interaction (spinners, etc.)
│   │   └── ora-spinner-adapter.ts     # Adapter for ora spinner
│   ├── app.module.ts
│   └── main.ts
├── test/
│   └── ...
├── .agent/
│   └── memory.db                      # Example SQLite database file for persistence
├── .gitignore
├── README.md
└── tsconfig.json
```
*Note: The project structure is illustrative and may vary based on the exact implementation.*

---

*This documentation is prepared for Project Manager review, outlining the core architecture, development standards, and persistence strategy of the NestJS AI Agent Project.*
