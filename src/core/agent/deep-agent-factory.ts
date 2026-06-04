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

    // Phase 5 — Context Compression
    // deepagents ALREADY injects SummarizationMiddleware internally as a required
    // middleware (see REQUIRED_MIDDLEWARE_NAMES). Adding it manually causes
    // "Middleware SummarizationMiddleware is defined multiple times" error.
    // deepagents auto-configures trigger/keep thresholds from the model's token profile.
    // ModelFactory is kept for future use (e.g., custom summarization prompts).

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

    // Phase 5 — Context Compression (Orchestrator)
    // Same as simple agent: deepagents manages SummarizationMiddleware internally.
    // No manual middleware needed.

    return createDeepAgent({
      model,
      systemPrompt,
      checkpointer: checkpointer as any, // ADR-002
      subagents: [researcherSubAgent, coderSubAgent],
      tools: [                           // ADR-002
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
      // ADR-003 (updated): Dynamic tool exclusion for Gemini compatibility.
      // Instead of a hard-coded list, we auto-scan deepagents' built-in tools
      // and exclude any whose schemas contain Zod union types (anyOf/oneOf).
      // This future-proofs the harness profile against deepagents upgrades.
      const unsafeTools = DeepAgentFactory.detectGeminiIncompatibleTools();

      // Always exclude 'task' for the simple agent: deepagents injects 'task'
      // even without subagents. The simple agent works directly—no delegation.
      // (The orchestrator explicitly needs 'task' — it gets its own profile below.)
      const simpleAgentExcluded = [...new Set([...unsafeTools, 'task'])];

      registerHarnessProfile(model, {
        excludedTools: simpleAgentExcluded,
      });
    }

    // 3. Sync RAG index (lazy — skips if index is fresh < 5 min)
    await DeepAgentFactory.maybeReindex(rootDir, interaction);
  }

  /**
   * Detects deepagents' built-in tools that are incompatible with Gemini's schema requirements.
   *
   * Gemini rejects tool schemas containing Zod union types (anyOf/oneOf). This method
   * auto-scans all built-in deepagents tools by attempting to convert their schemas
   * using LangChain's Gemini converter. Any tool that throws is added to the exclusion list.
   *
   * This replaces the previous hard-coded list, making the harness profile automatically
   * future-proof: if deepagents adds new tools with union types, they are excluded without
   * any manual intervention.
   *
   * @returns Array of tool names that are incompatible with Gemini.
   */
  private static detectGeminiIncompatibleTools(): string[] {
    // Known always-problematic tools — hard-coded baseline (NEVER remove these).
    // grep, glob: Zod union types → Gemini rejects their schema at parse time.
    // ls, read_file, write_file, edit_file: Windows path bugs + no backup safety.
    // The auto-scan below catches any FUTURE tools deepagents may add with union types.
    const baselineExcluded = ['grep', 'glob', 'ls', 'read_file', 'write_file', 'edit_file'];

    // Attempt schema conversion for each built-in deepagent tool.
    // Tools that throw 'Gemini cannot handle union types' are added to the list.
    const schemaProbeExcluded: string[] = [];
    try {
      const { convertToOpenAITool } = require('@langchain/core/utils/function_calling');
      const { EMPTY_HARNESS_PROFILE } = require('deepagents');

      // EMPTY_HARNESS_PROFILE exposes the full list of built-in tool names.
      const builtInToolNames: string[] = EMPTY_HARNESS_PROFILE?.tools ?? [];

      for (const toolName of builtInToolNames) {
        // Skip tools we already know are problematic (fast path)
        if (baselineExcluded.includes(toolName)) continue;

        try {
          // Probe: attempt Gemini-compatible schema conversion
          // convertToOpenAITool throws for anyOf/oneOf schemas
          const toolDef = EMPTY_HARNESS_PROFILE?.toolDefs?.[toolName];
          if (toolDef?.schema) {
            convertToOpenAITool(toolDef); // throws if incompatible
          }
        } catch (conversionError: unknown) {
          const msg = (conversionError as Error)?.message ?? '';
          if (msg.includes('union') || msg.includes('anyOf') || msg.includes('oneOf')) {
            schemaProbeExcluded.push(toolName);
          }
        }
      }
    } catch {
      // If introspection fails (e.g., EMPTY_HARNESS_PROFILE structure changed),
      // fall back to the known-bad list to avoid a silent regression.
      return [...baselineExcluded, 'grep', 'glob'];
    }

    return [...new Set([...baselineExcluded, ...schemaProbeExcluded])];
  }

  /**
   * Clears the last (corrupted) checkpoint for a given thread.
   *
   * When Vertex AI returns "must include at least one parts field", it means the
   * SQLite checkpoint contains a message with empty content — usually from a tool
   * call that was interrupted mid-flight (e.g., Ctrl+C during a streaming tool call).
   *
   * This method deletes ONLY the most recent checkpoint entry for the thread, allowing
   * the session to continue from the previous stable state rather than starting fresh.
   *
   * @param rootDir - Project root directory (where `.agent/` lives).
   * @param threadId - The LangGraph thread ID of the corrupted session.
   * @param agentType - Which DB file to look in.
   * @returns true if a checkpoint was cleared, false if none was found.
   */
  public static clearCorruptedCheckpoint(
    rootDir: string,
    threadId: string,
    agentType: 'simple' | 'orchestrator' = 'simple',
  ): boolean {
    const dbFile = agentType === 'orchestrator' ? 'orchestrator_history.db' : 'deep_agent_history.db';
    const dbPath = path.join(rootDir, '.agent', dbFile);

    if (!fs.existsSync(dbPath)) return false;

    try {
      // Use better-sqlite3 directly — SqliteSaver doesn't expose delete APIs
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Database = require('better-sqlite3');
      const db = new Database(dbPath);

      let cleared = false;

      // Delete from all checkpoint tables for this thread
      for (const table of ['checkpoint_writes', 'checkpoints', 'checkpoint_blobs']) {
        try {
          const info = db.prepare(`DELETE FROM ${table} WHERE thread_id = ?`).run(threadId);
          if ((info as any).changes > 0) cleared = true;
        } catch {
          // Table might not exist in older schema versions — skip
        }
      }

      db.close();
      return cleared;
    } catch {
      return false;
    }
  }

  /**
   * Conditionally re-indexes the project only when the RAG index is stale.
   *
   * Reads `.agent/index.meta.json` to check the last index timestamp.
   * If the index was built less than `FRESH_TTL_MS` milliseconds ago, the
   * re-index is skipped entirely — saving 3-5 seconds on every startup.
   * If stale or missing, a full `indexProject()` run is triggered and the
   * metadata file is updated with the new timestamp.
   *
   * @param rootDir - The project root directory.
   * @param interaction - Optional interaction service for CLI task indicators.
   */
  private static async maybeReindex(
    rootDir: string,
    interaction?: InteractionService,
  ): Promise<void> {
    /** Maximum age (ms) before the index is considered stale and rebuilt. */
    const FRESH_TTL_MS = 5 * 60 * 1000; // 5 minutes
    const metaPath = path.join(rootDir, '.agent', 'index.meta.json');

    let isStale = true;
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as { indexedAt: number };
        isStale = Date.now() - meta.indexedAt > FRESH_TTL_MS;
      } catch {
        // Corrupted meta → treat as stale
        isStale = true;
      }
    }

    if (!isStale) {
      if (interaction) {
        interaction.startTask('Index is fresh ✓ (skipping re-index)').succeed('Index is fresh ✓');
      }
      return;
    }

    if (interaction) {
      const task = interaction.startTask('Syncing codebase index...');
      await new IndexerService().indexProject();
      task.succeed('Codebase index synced ✅');
    } else {
      await new IndexerService().indexProject();
    }

    // Persist timestamp so the next startup can skip re-indexing
    fs.writeFileSync(metaPath, JSON.stringify({ indexedAt: Date.now() }), 'utf-8');
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

⚡ TASK SIZING — classify before starting:
- SMALL (1-2 files, obvious change): DO NOT use write_todos. Read → Write → Done. Max 3 tool calls.
- MEDIUM (3+ files, new feature): Use write_todos briefly (3-5 steps max).
- LARGE (full module, major refactor): Full protocol with write_todos.

NEVER use more than 3 tool calls for a change that fits in a single file.

📋 PLANNING PROTOCOL (MEDIUM/LARGE only):
Before starting ANY task with more than one step:
1. Call \`write_todos\` to create a structured, numbered plan.
2. Execute each step, calling \`update_todo\` (NOT update_todos — exact name: update_todo) when a step is done.
3. If you lose track, call \`read_todos\` to re-orient yourself.

TODO TOOL NAMES (exact, case-sensitive):
- write_todos   ← create the plan
- read_todos    ← re-read the plan
- update_todo   ← mark ONE step done (singular, not plural)

📂 EXPLORATION STRATEGY:
- Use \`ask_codebase\` for semantic RAG search of the codebase.
- Use \`list_files\` for directory structure inspection.
- Use \`safe_read_file\` to read actual file contents before modifying.
- After writes, call \`refresh_project_index\` if RAG results seem stale.

🤖 AUTONOMOUS EXECUTION (CRITICAL):
Once you have a plan (write_todos), execute ALL steps without stopping.
- DO NOT ask "should I continue?", "shall I proceed?", or "yes/no?" questions.
- DO NOT wait for user confirmation between steps.
- After each step: announce what you just did + what comes next, then immediately do it.
- Format: "✅ Step N done — [what was done]. Now doing Step N+1: [what comes next]..."
- Only stop when ALL todos are marked done OR a HITL gate fires.

🛑 HITL GATES — use \`ask_human\` ONLY for these:
- Deleting files or directories (irreversible)
- Dropping database tables or migrations
- Modifying critical infra files (docker-compose, CI/CD, .env.production)
- You've failed 3 times and genuinely need guidance
Everything else → just do it and announce it.

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
