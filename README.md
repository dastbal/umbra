# NestJS AI Agent

An AI-powered autonomous agent for code analysis, understanding, and modification within NestJS applications. Built for Principal Software Engineer level tasks using RAG and a Multi-Agent architecture.

## Table of Contents
- [Getting Started (Quick Setup)](#getting-started-quick-setup)
- [Architecture](#architecture)
- [Graph Flow](#graph-flow)
- [RAG Strategy (X-Ray)](#rag-strategy-x-ray)
- [Cost Tracking & Usage Metrics](#cost-tracking--usage-metrics)
- [Development Standards](#development-standards)
- [Persistence Strategy](#persistence-strategy)
- [Project Structure](#project-structure)

## Getting Started (Quick Setup)

### 1. Installation
Install the package via npm:
```bash
npm install @dastbal/nestjs-ai-agent
```

### 2. Configuration
Create a `.env` file in your project root with your Google Cloud Vertex AI credentials and chosen models:

```dotenv
# Vertex AI JSON Credentials Path
GOOGLE_APPLICATION_CREDENTIALS="/absolute/path/to/your/keyfile.json"

# Models
GOOGLE_CLOUD_MODEL_NAME="gemini-1.0-pro"
EMBEDDING_MODEL_NAME="textembedding-004"
```

### 3. Usage

#### Import in NestJS
Import the module into your `app.module.ts`:

```typescript
import { AiAgentModule } from '@dastbal/nestjs-ai-agent';

@Module({
  imports: [
    AiAgentModule.forRoot(),
  ],
})
export class AppModule {}
```

#### Run the Agent (CLI)
Interact with the agent directly using the built-in CLI:

```bash
# Start multi-agent mode
npm run agent "Explícame la arquitectura de este proyecto"
```
*(The first run will automatically sync and index your codebase for RAG context).*

#### Advanced CLI Commands (Optional)
If your CLI is configured for standalone tool execution, you can trigger them manually:

```bash
# Manually trigger RAG indexing
npm run cli -- index --dir src

# Use Researcher to analyze dependencies
npm run cli -- research src/my-service.ts
```

---

## Architecture

### Multi-Agent System

The project employs a sophisticated multi-agent architecture where specialized agents collaborate to perform complex code-related tasks. This modular approach enhances maintainability, scalability, and allows for focused development of each agent's capabilities.

#### Supervisor Agent

*   **Role:** The central orchestrator. The Supervisor agent is responsible for managing the overall workflow and task execution. It delegates tasks to specialized agents (Researcher, Coder), monitors their progress, and coordinates their interactions to achieve a larger objective. It acts as the main entry point for complex operations that require multiple steps or agent collaborations.
*   **Key Files:**
    *   `src/core/agent/graph/supervisor.graph.ts`: Defines the state machine or graph structure that dictates the flow of tasks and agent interactions.
    *   `src/core/agent/supervisor.service.ts`: Contains the core logic for task delegation, state management, and coordination between agents.

#### Researcher Agent

*   **Role:** The intelligence gatherer. The Researcher agent specializes in analyzing the codebase, understanding its structure, identifying dependencies, and retrieving relevant information. It heavily utilizes the RAG Discovery Strategy (X-Ray) to query and interpret code. Its findings are crucial for informing the Coder agent's actions or providing insights to the user.
*   **Key Files:**
    *   `src/core/agent/researcher.service.ts`: Implements the Researcher's core functionalities.
    *   `src/core/rag/retriever.ts`: Handles the retrieval of relevant code chunks and context augmentation using semantic search and dependency information.
    *   `src/core/tools/ast/chunker.ts`: Responsible for parsing code into Abstract Syntax Trees (ASTs) and segmenting it into meaningful chunks for analysis.

#### Coder Agent

*   **Role:** The code manipulator. The Coder agent is responsible for generating, modifying, and refactoring code. It receives instructions, often based on the analysis provided by the Researcher, and applies strict development standards ('Surgeon's Rule', 'Golden Prompt') to ensure the generated or modified code is of high quality, safe, and maintainable.
*   **Key Files:**
    *   `src/core/agent/coder.service.ts`: Contains the core logic for code generation and modification tasks.
    *   `src/core/agent/graph/coder.graph.ts`: Defines the specific task execution graph for the Coder agent, outlining its internal workflows.

---

## Graph Flow

The interaction between agents is managed through graph-based execution, typically using a library like LangGraph. This allows for defining complex workflows as state machines or directed graphs.

*   **Supervisor as Orchestrator:** The Supervisor agent often defines the high-level graph that dictates the sequence of operations. For example, a task might involve:
    1.  Supervisor receives a request.
    2.  Supervisor delegates analysis to Researcher.
    3.  Researcher performs analysis using RAG (X-Ray).
    4.  Researcher returns findings to Supervisor.
    5.  Supervisor instructs Coder based on findings.
    6.  Coder modifies code, adhering to standards.
    7.  Supervisor confirms completion or initiates further steps.
*   **Agent-Specific Graphs:** Individual agents like the Coder may also have their own internal graphs to manage complex sub-tasks (e.g., parsing, modification, validation).
*   **State Management:** The graph execution manages the state transitions between different nodes (tasks or agent calls), ensuring a coherent flow.

*   **Key Files:** `src/core/agent/graph/supervisor.graph.ts`, `src/core/agent/graph/coder.graph.ts`.

---

## RAG Strategy (X-Ray)

The Researcher agent employs an advanced RAG (Retrieval-Augmented Generation) strategy, termed "X-Ray," to achieve a deep and context-aware understanding of the codebase. This strategy combines semantic search with structural analysis.

1.  **Code Indexing:**
    *   The process begins with indexing the codebase. Files are scanned, and their content is parsed using Abstract Syntax Trees (ASTs) via the `NestChunker`.
    *   Code is broken down into meaningful segments (`ProcessedChunk`).
    *   Structural dependencies (e.g., import statements) are extracted, forming a dependency graph (`GraphEdge`).
    *   **Key Files:** `src/core/rag/indexer.ts` (Orchestrates the indexing pipeline), `src/core/tools/ast/chunker.ts` (Handles AST parsing, chunking, and dependency extraction).
2.  **Semantic Search & Retrieval:**
    *   When a query is made, the Researcher generates an embedding for the query and performs a vector similarity search against the indexed code chunks stored in the `AgentDB`.
    *   This retrieves the most semantically relevant code segments.
    *   **Key Files:** `src/core/rag/retriever.ts` (Implements `query` method for semantic search).
3.  **Context Augmentation:**
    *   To provide rich context, the retrieved code chunks are augmented with additional information:
        *   **File Dependencies:** The import graph for the file containing the chunk is retrieved.
        *   **Code Structure:** A simplified "skeleton" of the file (e.g., class and method signatures) is fetched.
    *   This multi-faceted information provides a deep understanding of the code's context and relationships.
    *   **Key Files:** `src/core/rag/retriever.ts` (Implements `getContextForLLM` which performs augmentation using `getDependencies` and `getFileSkeleton`).
4.  **Report Generation:**
    *   All gathered information (query, relevant chunks, scores, dependencies, skeletons) is compiled into a structured "RAG ANALYSIS REPORT". This comprehensive report serves as the input context for the LLM, enabling more informed responses and actions.

This "X-Ray" strategy allows the agents to "see" into the codebase's structure and semantics, facilitating accurate analysis and modification.

---

## Cost Tracking & Usage Metrics

The system now includes built-in real-time cost tracking and token usage monitoring for transparency and resource management.

### Features
- **Real-time Monitoring**: See exact token counts (prompt/completion) and USD cost for every agent action.
- **Configurable Pricing**: Easily update model prices via `llm-pricing.json` in the root directory.
- **DDD Implementation**: Uses `Money` and `TokenUsage` Value Objects for high-precision calculations.
- **Visual Feedback**: Integration with the CLI spinner shows status and cost metrics upon success.

### Configuration (`llm-pricing.json`)
You can customize the cost per million tokens for any model:
```json
{
  "gemini-2.0-flash-lite-001": {
    "inputPricePerMillion": 0.1,
    "outputPricePerMillion": 0.3
  }
}
```

---

## Development Standards

### Surgeon's Rule

The 'Surgeon's Rule' is a set of rigorous principles that the Coder agent strictly adheres to, ensuring that code modifications are performed with utmost care, precision, and minimal risk of regression. It emphasizes a deep understanding of the code before any changes are made.

1.  **Read-Before-Write:**
    *   **Description:** Before altering any code, the agent must thoroughly read and comprehend the existing code, its purpose, its dependencies, and its context within the broader system. This involves understanding the implications of any potential change.
    *   **Implementation:** Guided by the Researcher's analysis and direct code inspection.
2.  **Preservation First (Anti-Regression):**
    *   **Description:** The primary goal is to preserve existing functionality and unrelated business logic. Changes should be targeted and isolated to the specific task, avoiding unintended side effects on other parts of the codebase. Existing comments, TSDocs, and code structure should be maintained unless they are the direct subject of modification.
    *   **Implementation:** Focus on minimal, surgical changes; careful review of impact; maintaining code style and documentation.
3.  **Differential Analysis:**
    *   **Description:** The agent must clearly understand the difference between the existing code and the proposed changes. The focus is on implementing *only* the intended modifications, ensuring no extraneous code is introduced or existing code is altered unintentionally.
    *   **Implementation:** Comparing old and new code states, validating changes against the prompt's requirements.

*   **Application:** These rules are embedded in the Coder agent's operational logic and prompt engineering, guiding its code generation and modification processes.

### Golden Prompt

The 'Golden Prompt' is a standardized approach to crafting prompts for AI interactions, particularly for instructing the Coder agent. It ensures that prompts are clear, comprehensive, and provide all necessary information for the AI to generate accurate, high-quality, and contextually relevant code.

*   **Key Characteristics:**
    *   **Clarity and Specificity:** The objective and desired outcome are stated unambiguously.
    *   **Contextual Richness:** Includes relevant background information, existing code snippets, architectural constraints, and data structures.
    *   **Adherence to Standards:** Explicitly mentions standards to follow, such as the 'Surgeon's Rule', specific design patterns (e.g., DDD), or coding style guidelines.
    *   **Defined Output Format:** Specifies the expected structure, format, or type of the generated code (e.g., a specific function signature, a class definition, a DTO).
    *   **Error Handling Considerations:** May include instructions on how to handle potential errors or edge cases.

*   **Application:** Prompts are carefully constructed based on these principles, often by the Supervisor or Researcher agents, before being sent to the Coder agent.

---

## Persistence Strategy

### Isolated SQLite Persistence

The project employs a robust persistence strategy that ensures data isolation and efficient state management for each agent.

*   **Core Idea:** Instead of a single, monolithic database, each agent (or a logical group of agents) manages its own dedicated SQLite database file.
*   **Implementation:**
    *   The `AgentDB` service acts as an abstraction layer over the actual database implementation.
    *   `SqliteSaver` provides the concrete implementation for interacting with SQLite databases.
    *   Each agent instance is typically associated with a specific SQLite file (e.g., `.agent/memory.db` for a default agent).
*   **Data Managed:** These isolated databases store crucial agent-specific information:
    *   **Code Embeddings:** Vector representations of code chunks used for RAG.
    *   **Dependency Graph:** Structural relationships between code files.
    *   **Agent State:** Memory, history, and configuration specific to the agent.
*   **Benefits:**
    *   **Data Isolation:** Prevents data conflicts and unintended side effects between different agents.
    *   **Modularity & Scalability:** Simplifies agent development and allows for independent scaling or deployment.
    *   **Performance:** Localized data access can lead to faster read/write operations for agent-specific tasks.
    *   **Simplicity:** SQLite is lightweight and easy to manage, requiring no separate database server.
*   **Key Files:**
    *   `src/core/state/db.ts`: Defines the interface for database operations.
    *   `src/core/state/sqlite-saver.ts`: Implements the SQLite persistence logic.
    *   `src/core/agent/factory.ts`: Responsible for creating agent instances and configuring their persistence layers.

This strategy ensures that each agent operates with its own clean state, enhancing the overall reliability and maintainability of the system.

---

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
├── .agent/
│   └── memory.db                      # Example SQLite database file for persistence
├── .env                               # Environment variables configuration
├── .gitignore
├── README.md
├── tsconfig.json
└── package.json
```
*Note: The project structure is illustrative and may vary based on the exact implementation.*
