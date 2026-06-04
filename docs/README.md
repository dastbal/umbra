# NestJS AI Agent Project Documentation

This document provides a guide to using and understanding the NestJS AI Agent Project, tailored for project managers and developers. It prioritizes practical usage and results, followed by architectural and strategic details.

## Table of Contents

1.  [Usage & Commands](#usage--commands)
2.  [Architecture](#architecture)
    *   [Multi-Agent System](#multi-agent-system)
        *   [Supervisor Agent](#supervisor-agent)
        *   [Researcher Agent](#researcher-agent)
        *   [Coder Agent](#coder-agent)
3.  [Graph Flow](#graph-flow)
4.  [RAG Strategy (X-Ray)](#rag-strategy-x-ray)
5.  [Development Standards](#development-standards)
    *   [Surgeon's Rule](#surgeons-rule)
    *   [Golden Prompt](#golden-prompt)
6.  [Persistence Strategy](#persistence-strategy)
    *   [Isolated SQLite Persistence](#isolated-sqlite-persistence)
7.  [Getting Started](#getting-started)

---

## Usage & Commands

This section details how to interact with the AI Agent system, focusing on practical application and available commands.

### Core Functionality

The AI Agent system is designed to assist with code analysis, understanding, and modification. Interaction is primarily through the command line interface (CLI), which allows triggering specific agent tasks.

### Running the Agent

Before running, ensure you have completed the setup steps in the [Getting Started](#getting-started) section, including installing dependencies and configuring environment variables.

*   **Start the Application:**
    ```bash
    npm run start:dev
    ```
    This command starts the NestJS application in development mode. Upon startup, the agent typically initiates its indexing process to build its knowledge base from the codebase.

### CLI Commands

The agent exposes several commands via a CLI interface (conceptualized here, actual commands may vary based on implementation). These commands allow you to trigger specific agent actions.

*   **Indexing:** Manually trigger the RAG indexing process.
    ```bash
    # Example: Index the entire 'src' directory
    npm run cli -- index --dir src
    ```
    *   **Purpose:** Updates the agent's knowledge base with the latest code changes. Essential for ensuring the agent has up-to-date information for analysis and refactoring.

*   **Research:** Utilize the Researcher agent to analyze specific code files or components.
    ```bash
    # Example: Analyze a specific file
    npm run cli -- research src/my-component.ts

    # Example: Analyze dependencies of a file
    npm run cli -- research --dependencies src/my-service.ts
    ```
    *   **Purpose:** Provides insights into code structure, dependencies, and potential issues. Useful for understanding the impact of changes or debugging.

*   **Code Actions (Refactoring, Generation):** Instruct the Coder agent to perform code modifications or generation tasks.
    ```bash
    # Example: Refactor a function with specific instructions
    npm run cli -- code refactor --file src/utils.ts --prompt "Refactor the 'calculateTotal' function to improve performance and add error handling."

    # Example: Generate a new DTO based on requirements
    npm run cli -- code generate --type dto --prompt "Create a DTO for user profile data including name, email, and registration date."
    ```
    *   **Purpose:** Automates code improvements, refactoring, and generation based on natural language instructions, adhering to project standards.

*   **Supervisor Commands:** (If applicable) Commands to manage agent workflows or complex tasks.
    ```bash
    # Example: Run a complex analysis workflow
    npm run cli -- supervisor run-workflow --workflow analyze-feature --params '{"feature": "user-auth"}'
    ```
    *   **Purpose:** Orchestrates multi-step processes involving different agents.

**Note:** The exact CLI commands and their parameters will depend on the specific implementation and may require consulting additional project-specific documentation or source code.

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
    *   **Key Files:** `src/core/rag/retriever.ts` (Implements the `query` method for semantic search).
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

## Getting Started

This section provides instructions for setting up and running the AI Agent project.

### Prerequisites

*   **Node.js:** Version 18.x or higher is recommended.
*   **Google Cloud Account:** Access to Google Cloud Platform is required for using Vertex AI services.
*   **Google Cloud SDK:** Installed and configured.

### 1. Install Dependencies

Navigate to the project's root directory in your terminal and run the following command to install all necessary Node.js dependencies:

```bash
npm install
```

### 2. Configure Google Vertex AI Credentials

This project uses Google Vertex AI for its language models and embeddings. You need to provide your service account credentials.

*   **Create a Service Account:** If you haven't already, create a service account in your Google Cloud project with the necessary roles (e.g., Vertex AI User). Download the service account key as a JSON file.
*   **Set Environment Variable:** Set the `GOOGLE_APPLICATION_CREDENTIALS` environment variable to the absolute path of your downloaded JSON key file.

    **Example (Linux/macOS):**
    ```bash
    export GOOGLE_APPLICATION_CREDENTIALS="/path/to/your/keyfile.json"
    ```

    **Example (Windows Command Prompt):**
    ```bash
    set GOOGLE_APPLICATION_CREDENTIALS="C:\path\to\your\keyfile.json"
    ```

    **Example (Windows PowerShell):**
    ```powershell
    $env:GOOGLE_APPLICATION_CREDENTIALS="C:\path\to\your\keyfile.json"
    ```
    *Note: For persistent configuration, add this line to your shell's profile file (e.g., `.bashrc`, `.zshrc`, or system environment variables).*

### 3. Environment Variables (`.env` file)

Create a `.env` file in the root directory of the project and populate it with your specific configuration.

**Example `.env` file:**

```dotenv
# Google Cloud Project Configuration
GOOGLE_CLOUD_PROJECT="your-gcp-project-id"
GOOGLE_CLOUD_REGION="us-central1" # e.g., us-central1

# Vertex AI Model Configuration
GOOGLE_CLOUD_MODEL_NAME="gemini-1.0-pro" # Or other compatible model like 'gemini-1.5-pro-preview-0414'
EMBEDDING_MODEL_NAME="textembedding-004" # Default embedding model

# Agent Configuration
AGENT_SOURCE_DIR="src" # Directory to index for RAG

# Persistence Configuration
PERSISTENCE_PATH=".agent/memory.db" # Path for the SQLite database
```

*Replace placeholders like `"your-gcp-project-id"` and `"us-central1"` with your actual Google Cloud project details and desired region.*

### 4. Running the Agent

Once dependencies are installed and environment variables are configured, you can run the agent using the NestJS CLI.

*   **Start the application:**
    ```bash
    npm run start:dev
    ```
    This command will compile the TypeScript code and start the NestJS application in development mode. The agent will typically begin its indexing process upon startup.

*   **Interacting with the Agent:**
    The primary interaction with the agent is expected to be through its core functionalities, which might be exposed via:
    *   **CLI Commands:** Specific commands might be available to trigger indexing, run analysis tasks, or perform code modifications. (e.g., `npm run cli -- index`, `npm run cli -- analyze src/my-file.ts`). *Note: The exact CLI commands depend on the implementation of the CLI interface.*
    *   **Programmatic Usage:** You can import and use the agent services (Supervisor, Researcher, Coder) within other parts of your application or in separate scripts.

    **Example CLI Interaction (Conceptual):**
    Assuming a CLI script is set up (e.g., in `src/cli.ts`):

    ```bash
    # Trigger a full indexing of the 'src' directory
    npm run cli -- index --dir src

    # Ask the Researcher to analyze a specific file
    npm run cli -- research src/my-component.ts

    # Instruct the Coder to refactor a function (requires more complex prompt setup)
    npm run cli -- code refactor --file src/utils.ts --prompt "Refactor the 'calculateTotal' function to improve performance and add error handling."
    ```

    *Refer to the specific implementation details or additional documentation for available CLI commands and their usage.*

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
│   ├── cli.ts                         # Example CLI entry point (if implemented)
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
*Note: The project structure is illustrative and may vary based on the exact implementation. The CLI interaction examples are conceptual and depend on a dedicated CLI script being implemented.*

---

*This README has been updated with a detailed 'Getting Started' guide, including dependency installation, Google Vertex AI credential configuration, an example `.env` file, and guidance on running the agent via the CLI.*
