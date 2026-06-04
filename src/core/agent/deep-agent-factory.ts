import {
  createDeepAgent,
  registerHarnessProfile,
} from 'deepagents';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { InteractionService } from '../interaction';
import { IndexerService } from '../rag/indexer';
import { resolveModel, isGeminiModel } from '../config/model-resolver';
import {
  askCodebaseTool,
  executeTestsTool,
  integrityCheckTool,
  refreshIndexTool,
  safeWriteFileTool,
  safeReadFileTool,
  listFilesTool,
} from '../tools';
import { researcherSubAgent } from '../subagents/researcher.subagent';
import { coderSubAgent } from '../subagents/coder.subagent';
import * as path from 'path';
import * as fs from 'fs';

// ── Architecture Decision Records ──────────────────────────────────────────────
//
// ADR-001: No `backend` param in createDeepAgent
//   deepagents v1.10.x auto-injects filesystem tools (grep, glob) when a `backend`
//   is provided. The `grep` tool uses Zod union types rejected by Gemini's schema
//   converter. We omit `backend` and use our custom tools (safeWriteFileTool,
//   safeReadFileTool) which already integrate SafeFilesystemBackend with backup logic.
//
// ADR-002: `as any` at dual @langchain/core boundary
//   deepagents vendors its own internal copy of @langchain/core. Our project's
//   SqliteSaver and DynamicStructuredTool types are structurally incompatible at
//   compile time despite being identical at runtime. Cast `as any` at these points.
//
// ADR-003: registerHarnessProfile with exact model string
//   deepagents resolves harness profiles using the EXACT model string as spec key.
//   Use `registerHarnessProfile(model, ...)` where `model` is the exact string
//   passed to createDeepAgent (not 'google' or 'gemini').
//
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Configuration for the DeepAgent factory methods.
 */
export interface DeepAgentFactoryConfig {
  /**
   * Unique thread ID for conversation persistence.
   * Each thread maintains its own isolated history via SQLite.
   * @default "deep-agent-session"
   */
  threadId?: string;

  /**
   * The LLM model string to use.
   * Resolution priority: AGENT_MODEL env var > this value > DEFAULT_MODEL.
   * Examples: "gemini-2.5-flash-lite", "gemini-2.5-pro", "ollama:llama3.2"
   * @see src/core/config/model-resolver.ts
   * @default "gemini-2.5-flash-lite"
   */
  model?: string;

  /**
   * The root directory the agent operates on.
   * The agent is sandboxed to this directory for all filesystem operations.
   * @default process.cwd()
   */
  rootDir?: string;

  /**
   * Enable context compression via SummarizationMiddleware.
   * When true, old messages are automatically summarized when context fills up.
   * Recommended for long-running tasks (refactors, multi-file implementations).
   * @default true for orchestrator, false for simple deep agent
   */
  enableContextCompression?: boolean;
}

/**
 * 🚀 DEEP AGENT FACTORY
 *
 * Provides two factory methods for creating AI agents:
 *
 * ## `create()` — Simple Deep Agent
 * A single autonomous agent with planning tools (write_todos), filesystem access
 * (safe_write_file, safe_read_file), and RAG search (ask_codebase).
 * Use for: quick tasks, single-file changes, Q&A about the codebase.
 *
 * ## `createOrchestrator()` — Multi-SubAgent Orchestrator ⭐
 * An orchestrating agent that delegates to specialized subagents:
 * - **Researcher**: analyzes the codebase and produces implementation plans
 * - **Coder**: implements code following TDD and DDD, receives the Researcher's plan
 * Use for: complex features, new modules, architectural changes.
 *
 * ## Architecture Decisions
 * See ADR-001 through ADR-003 in the comments above the class.
 * See also: docs/ARCHITECTURE.md for the full architectural context.
 *
 * @example Simple deep agent
 * ```ts
 * const agent = await DeepAgentFactory.create({ threadId: "session-123" });
 * const result = await agent.invoke(
 *   { messages: [{ role: "human", content: "Add a findById method to UsersService" }] },
 *   { configurable: { thread_id: "session-123" } }
 * );
 * ```
 *
 * @example Orchestrator
 * ```ts
 * const orchestrator = await DeepAgentFactory.createOrchestrator({ threadId: "task-001" });
 * const result = await orchestrator.invoke(
 *   { messages: [{ role: "human", content: "Create a complete UsersModule with DDD" }] },
 *   { configurable: { thread_id: "task-001" } }
 * );
 * ```
 */
export class DeepAgentFactory {
  /**
   * Creates a simple deep agent for quick, single-agent tasks.
   *
   * Includes: write_todos, ask_human, safe filesystem tools, RAG tools.
   * Does NOT include: Researcher/Coder subagents, context compression.
   *
   * @param config - Optional configuration overrides.
   * @param interaction - Optional interaction service for CLI task indicators.
   * @returns A compiled DeepAgent ready for invocation.
   */
  // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
  public static async create(
    config: DeepAgentFactoryConfig = {},
    interaction?: InteractionService,
  ): Promise<any> {
    const rootDir = config.rootDir ?? process.cwd();
    const model = resolveModel(config.model);

    await DeepAgentFactory.bootstrap(rootDir, model, interaction);

    const checkpointer = DeepAgentFactory.buildCheckpointer(rootDir);
    const systemPrompt = DeepAgentFactory.buildSystemPrompt(rootDir, 'simple');

    return createDeepAgent({
      model,
      systemPrompt,
      checkpointer: checkpointer as any, // ADR-002
      tools: [                           // ADR-002
        safeWriteFileTool,
        safeReadFileTool,
        listFilesTool,
        askCodebaseTool,
        refreshIndexTool,
        integrityCheckTool,
        executeTestsTool,
      ] as any[],
    });
  }

  /**
   * Creates an Orchestrator agent with Researcher and Coder subagents.
   *
   * The Orchestrator delegates to specialized subagents via the `task` tool:
   * - **researcher**: analyzes codebase, returns a detailed implementation plan
   * - **coder**: implements code following TDD, receives the Researcher's plan
   *
   * Includes context compression to handle long tasks without losing context.
   *
   * Mandatory protocol (enforced by system prompt):
   * 1. write_todos → create plan
   * 2. task(researcher) → analyze and get implementation plan
   * 3. task(coder) → implement using the plan
   * 4. run_integrity_check → verify zero TypeScript errors
   *
   * @param config - Optional configuration overrides.
   * @param interaction - Optional interaction service for CLI task indicators.
   * @returns A compiled Orchestrator DeepAgent ready for invocation.
   */
  // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
  public static async createOrchestrator(
    config: DeepAgentFactoryConfig = {},
    interaction?: InteractionService,
  ): Promise<any> {
    const rootDir = config.rootDir ?? process.cwd();
    const model = resolveModel(config.model);
    const enableCompression = config.enableContextCompression ?? true;

    await DeepAgentFactory.bootstrap(rootDir, model, interaction);

    const checkpointer = DeepAgentFactory.buildCheckpointer(rootDir, 'orchestrator');
    const systemPrompt = DeepAgentFactory.buildSystemPrompt(rootDir, 'orchestrator');

    // NOTE (Phase 5 — Context Compression): createSummarizationMiddleware requires
    // an instantiated BaseChatModel instance, not a model string. This will be wired
    // in Phase 5 once we have a ModelFactory that returns a model instance.
    // For now, context compression is deferred.
    void enableCompression; // acknowledged, not yet implemented

    return createDeepAgent({
      model,
      systemPrompt,
      checkpointer: checkpointer as any, // ADR-002
      // Phase 2 + 3: Researcher and Coder SubAgents
      // deepagents uses lowercase `subagents` (not `subAgents`)
      subagents: [researcherSubAgent, coderSubAgent],
      tools: [                           // ADR-002
        // Orchestrator keeps RAG + integrity — it needs to verify the final result
        askCodebaseTool,
        refreshIndexTool,
        integrityCheckTool,
      ] as any[],
    });
  }

  // ── Private Helpers ────────────────────────────────────────────────────────

  /**
   * Shared bootstrap logic: setup directories, register harness profile, sync RAG index.
   *
   * Called by both `create()` and `createOrchestrator()` before building the agent.
   *
   * @param rootDir - The project root directory.
   * @param model - The resolved model string.
   * @param interaction - Optional interaction service.
   */
  private static async bootstrap(
    rootDir: string,
    model: string,
    interaction?: InteractionService,
  ): Promise<void> {
    // 1. Setup .agent directory
    const agentDir = path.join(rootDir, '.agent');
    if (!fs.existsSync(agentDir)) fs.mkdirSync(agentDir, { recursive: true });

    // 2. Register Gemini-compatible harness profile (ADR-003)
    // Gemini rejects Zod union types in tool schemas. `grep` and `glob` built-in
    // tools use union types → crash at invoke time. We exclude them for Gemini models.
    // The key MUST be the exact model string, not a provider prefix like 'google'.
    if (isGeminiModel(model)) {
      registerHarnessProfile(model, { excludedTools: ['grep', 'glob'] });
    }

    // 3. Sync RAG index
    if (interaction) {
      const task = interaction.startTask('Syncing codebase index...');
      await new IndexerService().indexProject();
      task.succeed('Codebase index synced ✅');
    } else {
      await new IndexerService().indexProject();
    }
  }

  /**
   * Builds a SqliteSaver checkpointer for conversation persistence.
   *
   * Each agent type gets its own database file to avoid thread ID collisions
   * between simple deep agent sessions and orchestrator sessions.
   *
   * @param rootDir - The project root directory.
   * @param type - The agent type ('simple' | 'orchestrator').
   * @returns A configured SqliteSaver instance.
   */
  private static buildCheckpointer(
    rootDir: string,
    type: 'simple' | 'orchestrator' = 'simple',
  ): SqliteSaver {
    const agentDir = path.join(rootDir, '.agent');
    const dbFile = type === 'orchestrator' ? 'orchestrator_history.db' : 'deep_agent_history.db';
    const dbPath = path.join(agentDir, dbFile);
    return SqliteSaver.fromConnString(dbPath);
  }

  /**
   * Builds the system prompt for the given agent type.
   *
   * @param rootDir - The project root directory (injected into prompt for context).
   * @param type - The agent type ('simple' | 'orchestrator').
   * @returns The system prompt string.
   */
  private static buildSystemPrompt(
    rootDir: string,
    type: 'simple' | 'orchestrator',
  ): string {
    const base = `You are a Principal Software Engineer specialized in NestJS (Node.js).
You operate directly on the local file system of a live, real-world project at: ${rootDir}

💎 QUALITY STANDARDS (NON-NEGOTIABLE):
- Architecture: Follow DDD (Domain-Driven Design) and NestJS best practices.
- Strict TypeScript: The use of \`any\` is FORBIDDEN.
- Always document with TSDocs (technical English).
- Testing (TDD): DO NOT write code without its corresponding .spec.ts test.

🔍 SURGEON'S RULE:
1. Read-Before-Write: NEVER overwrite a file without reading it first with \`safe_read_file\`.
2. Preservation First: Do not delete TSDocs, existing logic, or unrelated code.
3. Anti-Regression: Understand why code exists before removing it.

🚨 SAFETY RULES:
- Never perform mass file deletions.
- When modifying core files (app.module.ts), double-check all imports.
- Use RELATIVE PATHS for all file operations (e.g., 'src/users/users.service.ts').
- After 3 failed self-correction attempts, use \`ask_human\` to request guidance.`;

    if (type === 'simple') {
      return base + `

📋 PLANNING PROTOCOL (MANDATORY):
Before starting ANY task with more than one step:
1. Call \`write_todos\` to create a structured, numbered plan.
2. Execute each step, calling \`update_todo\` when a step is done.
3. If you lose track, call \`read_todos\` to re-orient yourself.

📂 EXPLORATION STRATEGY:
- Use \`ask_codebase\` for semantic RAG search of the codebase.
- Use \`list_files\` for directory structure inspection.
- Use \`safe_read_file\` to read actual file contents before modifying.
- After writes, call \`refresh_project_index\` if RAG results seem stale.

🧪 TESTING PROTOCOL:
1. After \`safe_write_file\`, run \`run_tests\` for that specific file.
2. Run \`run_integrity_check\` before finishing a task.
3. Auto-Fix: If tests fail, analyze, re-read, and self-correct. Max 3 attempts.`;
    }

    // Orchestrator prompt
    return base + `

🎯 YOUR ROLE: ORCHESTRATOR
You coordinate specialized subagents to complete complex tasks.
You do NOT implement code yourself — you delegate to the right specialist.

📋 MANDATORY ORCHESTRATION PROTOCOL:
For EVERY task, follow this exact sequence:
1. Call \`write_todos\` with the full plan (Analysis → Implementation → Verification).
2. Call \`task\` with subagent "researcher":
   - Provide full context: what to build, existing patterns to follow, constraints.
   - The researcher returns a detailed implementation plan.
3. Call \`task\` with subagent "coder":
   - Pass the COMPLETE output from the researcher.
   - The coder implements, tests, and returns results.
4. Call \`run_integrity_check\` to verify zero TypeScript errors.
5. Report to the user: what was built, test results, any issues.

🤖 AVAILABLE SUBAGENTS:
- **researcher**: Analyzes codebase, reads files, returns implementation plan. Use FIRST.
- **coder**: Implements code with TDD. Receives the researcher's plan. Use SECOND.

📂 ORCHESTRATOR TOOLS:
- \`ask_codebase\`: For quick questions you can answer yourself without delegating.
- \`run_integrity_check\`: Final verification after coder finishes.
- \`refresh_project_index\`: If RAG seems stale after coder writes files.
- \`write_todos\`, \`task\`, \`ask_human\`: Standard orchestration tools.`;
  }
}
