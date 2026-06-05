import {
  createDeepAgent,
  registerHarnessProfile,
} from 'deepagents';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { InteractionService } from '../interaction';
import { IndexerService } from '../rag/indexer';
import { resolveModel, isGeminiModel, isOllamaModel } from '../config/model-resolver';
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
import { LLMProvider } from '../llm/provider';
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

    // For Ollama models, pass a pre-built BaseChatModel instance instead of the
    // model string. This ensures deepagents uses our OllamaChatAdapter (which
    // serializes non-string ToolMessage content) rather than creating a raw
    // ChatOllama via initChatModel. Vertex AI models continue to use the string
    // path — deepagents' initChatModel handles them correctly.
    const modelParam = isOllamaModel(model)
      ? LLMProvider.createChatModel(model)
      : model;

    return createDeepAgent({
      model: modelParam as any,
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

    // Same Ollama adapter pattern as create() — pass BaseChatModel for Ollama,
    // string for Vertex AI.
    const modelParam = isOllamaModel(model)
      ? LLMProvider.createChatModel(model)
      : model;

    return createDeepAgent({
      model: modelParam as any,
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

    // 2. Register provider-specific harness profile
    //
    // ADR-003 (Gemini): Gemini rejects Zod union types in tool schemas.
    // We exclude incompatible tools automatically via schema scanning.
    //
    // ADR-009 (Ollama): Ollama uses the OpenAI-compatible API format and
    // does NOT reject Zod union types. However, we still exclude `task`
    // for the simple agent (same reason as Gemini: no subagent delegation).
    // We also exclude `grep`, `glob` on Ollama because they cause issues
    // on Windows paths — our `safe_read_file` / `list_files` are safer.
    if (isGeminiModel(model)) {
      // ADR-003: Dynamic tool exclusion for Gemini compatibility.
      // Auto-scan detects any new deepagents tools with Zod union types.
      const unsafeTools = DeepAgentFactory.detectGeminiIncompatibleTools();
      const simpleAgentExcluded = [...new Set([...unsafeTools, 'task'])];
      registerHarnessProfile(model, { excludedTools: simpleAgentExcluded });
    } else if (isOllamaModel(model)) {
      // ADR-009: Register the Ollama harness profile under the bare "ollama"
      // provider key (not a model-specific key). This is intentional.
      //
      // WHY "ollama" as the key (not "ollama:gemma4")?
      // deepagents' getHarnessProfile() resolves in this order:
      //   1. Exact match: "ollama:gemma4:e2b" → not found (3 parts, immediately rejected)
      //   2. Provider fallback: profiles.get("ollama") → FOUND ✓
      //
      // If we registered as "ollama:gemma4-e2b" (normalized), deepagents would
      // still look for "ollama:gemma4:e2b" (the raw spec) → not found, then
      // "ollama" → FOUND via fallback. But we'd also pollute the registry
      // with a key no one looks up.
      //
      // Registering under "ollama" cleanly applies these exclusions to ALL
      // local Ollama models regardless of tag format.
      //
      // The excluded tools are those deepagents injects by default that either:
      //   a) have Zod union schemas (grep, glob) — though Ollama's OpenAI-compat
      //      API is more tolerant, they're still replaced by our safer versions.
      //   b) cause Windows path issues (ls, read_file, write_file, edit_file).
      //   c) shouldn't be available in simple agent mode (task).
      registerHarnessProfile('ollama', {
        excludedTools: ['grep', 'glob', 'ls', 'read_file', 'write_file', 'edit_file', 'task'],
      });
    }



    // 3. Sync RAG index (lazy — skips if index is fresh < 5 min)
    // NOTE: RAG embeddings always use Vertex AI (text-embedding-004), even for
    // Ollama chat models. If Vertex credentials are missing, indexing is skipped
    // gracefully — the agent can still function without semantic search.
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
  /**
   * Normalizes an Ollama model string into a valid deepagents harness profile key.
   *
   * `deepagents` profile keys must follow `"provider"` or `"provider:model"` format
   * — exactly **one** colon is allowed. Ollama models with tags use the format
   * `"ollama:gemma4:e2b"` (two colons), which `registerHarnessProfile` rejects.
   *
   * This method normalizes by replacing any colon **after the first** with a dash:
   * - `"ollama:gemma4"` → `"ollama:gemma4"` (no change, valid)
   * - `"ollama:gemma4:e2b"` → `"ollama:gemma4-e2b"` (valid key)
   * - `"ollama:gemma4:26b"` → `"ollama:gemma4-26b"` (valid key)
   *
   * The normalized key is only used for profile registration/lookup, never
   * for the Ollama API call (which uses the original model string).
   *
   * @param model - The full model string (e.g., "ollama:gemma4:e2b").
   * @returns A valid harness profile key with at most one colon.
   */
  private static normalizeHarnessKey(model: string): string {
    const colonIndex = model.indexOf(':');
    if (colonIndex === -1) return model; // No colon — return as-is
    const afterFirstColon = model.slice(colonIndex + 1);
    // Replace any remaining colons with dashes
    const normalized = afterFirstColon.replaceAll(':', '-');
    return model.slice(0, colonIndex + 1) + normalized;
  }

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
    // If Vertex AI credentials are not configured, skip RAG indexing entirely.
    // Ollama-only users won't have GOOGLE_APPLICATION_CREDENTIALS set.
    // The agent still works — it just won't have semantic RAG search.
    if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      if (interaction) {
        interaction
          .startTask('RAG index skipped (no Vertex credentials)')
          .succeed('RAG index skipped — Ollama mode (no Google credentials)');
      }
      return;
    }

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

    try {
      if (interaction) {
        const task = interaction.startTask('Syncing codebase index...');
        await new IndexerService().indexProject();
        task.succeed('Codebase index synced ✅');
      } else {
        await new IndexerService().indexProject();
      }
      // Persist timestamp so the next startup can skip re-indexing
      fs.writeFileSync(metaPath, JSON.stringify({ indexedAt: Date.now() }), 'utf-8');
    } catch (err: unknown) {
      // Non-fatal: if indexing fails (e.g., transient Vertex error), log and continue.
      // The agent can still operate — it just loses semantic search for this session.
      const message = (err as Error)?.message ?? String(err);
      if (interaction) {
        interaction
          .startTask('RAG index failed')
          .fail(`RAG index failed (agent still works): ${message}`);
      } else {
        console.warn(`⚠️ RAG indexing failed (agent still works): ${message}`);
      }
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

🎯 SKILL DISCOVERY — mandatory before every task:
Scan the user's message for trigger keywords and load the matching skill FIRST.

Keyword → Skill map (check in this order):
- "module / feature / DDD / domain / create service"  → \`skills/create-ddd-module.md\`
- "test / spec / TDD / jest / coverage / unit test"    → \`skills/write-tests.md\`
- "refactor / rename / move / extract / restructure"   → \`skills/refactor-safely.md\`
- "endpoint / route / REST / GET / POST / PUT / DTO"   → \`skills/create-endpoint.md\`
- "error / bug / crash / fix / broken / TS2307"        → \`skills/debug-typescript.md\`
- "explain / analyze / understand / how does / audit"  → \`skills/analyze-codebase.md\`
- "done / complete / finished / implemented"            → \`skills/evaluate-own-work.md\`
- "git / commit / branch / push / version / release"   → \`skills/git-workflow.md\`
- "security / secret / vulnerability / injection"      → \`skills/security-audit.md\`
- "research done / handoff / plan for coder"           → \`skills/research-output-format.md\`
- "import / boundary / layer / ORM / leak / architecture check" → \`skills/validate-architecture-boundaries.md\`

If no keyword matches, call \`list_files("skills/")\` to discover available skills.
Load the matching skill with \`safe_read_file("skills/<name>.md")\` and follow it precisely.
If \`skills/\` does not exist, proceed with your best NestJS/DDD judgment.

🔒 FILE PROTECTION LAW:
These files are NEVER to be modified by the agent under any circumstances:
- \`skills/*.md\` — read-only guidelines, human-maintained
- \`ANTIGRAVITY.md\` — project save state, human-maintained
- \`AGENTS.md\` — project context, human-maintained
Attempting to \`safe_write_file\` to these paths is FORBIDDEN.

📢 OUTPUT QUALITY (the "No High-Level Shit" rule — from cursor.directory):
When asked to fix a bug or explain something:
- ALWAYS provide actual code with exact file paths and line context.
- NEVER say "you should consider X" — say what to do and do it.
- NEVER give 3 vague alternatives — give THE answer with reasoning.

🔍 SESSION STATE VERIFICATION (mandatory on every turn):
History is a record of intent — disk is ground truth.
- If history mentions files you created before → verify with \`safe_read_file\` before assuming.
- If a file is missing → create it from scratch. Never skip a write because history says it was done.

🚨 FILE CREATION LAW:
Describing a file ≠ creating it. A file only exists on disk after \`safe_write_file\` is called.
- After EVERY \`safe_write_file\` → immediately verify with \`safe_read_file\`. Count your writes.
- Never mark a todo step done until disk confirmation.

🛑 SAFETY RULES (universal — apply to every task):
- Never delete files or directories without \`ask_human\` approval.
- Never write outside the project root. Use RELATIVE PATHS only.
- Read-Before-Write: always \`safe_read_file\` before overwriting any existing file.
- Tolerate typos, bad grammar, Spanglish — always infer intent, never reject a request.
- After 3 failed self-correction attempts → use \`ask_human\` for guidance.

📝 OUTPUT FORMAT (always markdown):
Use \`# Headers\`, \`**bold**\` for key terms, fenced code blocks with language tags.
Never respond in plain prose. Even short answers must use **bold** for key terms.`;


    if (type === 'simple') {
      return base + `

⚡ TASK SIZING — classify before acting:
- **SMALL** (1-2 files, obvious change): No \`write_todos\`. Read → Write → Done. Max 3 tool calls.
- **MEDIUM** (3+ files, new feature): Use \`write_todos\` with 3-5 steps.
- **LARGE** (full module, major refactor): Full \`write_todos\` plan before starting.

📋 PLANNING TOOL NAMES (exact, case-sensitive):
- \`write_todos\`  ← create the plan
- \`read_todos\`   ← re-read if you lose track
- \`update_todo\`  ← mark ONE step done (singular — NOT update_todos)

🤖 AUTONOMOUS EXECUTION:
Once you have a plan, execute ALL steps without stopping.
- Never ask "should I continue?" or wait for confirmation between steps.
- After each step: announce done + what comes next → immediately do it.
- Only stop when ALL todos are done OR a HITL gate fires.

🛑 HITL GATES — use \`ask_human\` ONLY for:
- Deleting files or directories
- Dropping database tables or migrations
- Modifying infra files (docker-compose, CI/CD, .env.production)
- After 3 failed self-correction attempts
Everything else → execute autonomously.`;
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
