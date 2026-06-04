import { createDeepAgent, registerHarnessProfile } from 'deepagents';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { InteractionService } from '../interaction';
import { IndexerService } from '../rag/indexer';
import {
  askCodebaseTool,
  executeTestsTool,
  integrityCheckTool,
  refreshIndexTool,
  safeWriteFileTool,
  safeReadFileTool,
  listFilesTool,
} from '../tools';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Configuration for the DeepAgent factory.
 */
export interface DeepAgentFactoryConfig {
  /**
   * Unique thread ID for conversation persistence.
   * Each thread maintains its own isolated history via SQLite.
   * @default "deep-agent-session"
   */
  threadId?: string;

  /**
   * The LLM model string to use. Resolved automatically by deepagents.
   * Examples: "gemini-2.5-flash", "claude-3-5-sonnet-20241022", "gpt-4o"
   * @default "gemini-2.5-flash-lite"
   */
  model?: string;

  /**
   * The root directory for the SafeFilesystemBackend.
   * The agent will be sandboxed to this directory (virtualMode: true).
   * @default process.cwd()
   */
  rootDir?: string;
}

/**
 * 🚀 DEEP AGENT FACTORY
 *
 * Instantiates a production-grade autonomous agent using `createDeepAgent`
 * from the `deepagents` library — the full-power upgrade from the legacy
 * `createAgent` approach.
 *
 * ## What you gain vs. legacy factory
 * - ✅ `write_todos` / `read_todos` — built-in planning tools (AUTOMATIC)
 * - ✅ `ask_human` — built-in human-in-the-loop tool (AUTOMATIC)
 * - ✅ Context compression — automatic when context fills up (AUTOMATIC)
 * - ✅ `safe_write_file` / `safe_read_file` — with backup-before-write logic
 * - ✅ All your RAG tools — preserved and added on top
 *
 * ## Architecture Decision (ADR-001): Why no `backend` param?
 * deepagents v1.10.x auto-injects filesystem tools (ls, read_file, write_file,
 * grep, glob) when a `backend` is provided. The `grep` tool uses Zod union types
 * that are structurally incompatible with Gemini's parameter schema converter.
 * Since we cannot selectively exclude built-in tools, we omit `backend` entirely
 * and use our own filesystem tools (safeWriteFileTool, safeReadFileTool,
 * listFilesTool) which are Gemini-compatible and include SafeFilesystemBackend
 * backup logic.
 *
 * ## Architecture Decision (ADR-002): Dual @langchain/core boundary casts
 * deepagents vendors its own @langchain/core internally. The project's
 * SqliteSaver and DynamicStructuredTools come from a different copy,
 * causing TS structural mismatches. We cast to `any` at these boundary
 * points — runtime behavior is identical.
 *
 * @example
 * ```ts
 * const agent = await DeepAgentFactory.create({ threadId: "session-123" });
 * const result = await agent.invoke(
 *   { messages: [{ role: "human", content: "Create a UsersModule with DDD" }] },
 *   { configurable: { thread_id: "session-123" } }
 * );
 * ```
 */
export class DeepAgentFactory {
  /**
   * Creates and returns a fully configured deep agent ready for invocation.
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
    const model = config.model ?? 'gemini-2.5-flash-lite';

    // ── 1. Setup directories ────────────────────────────────────────────────
    const agentDir = path.join(rootDir, '.agent');
    if (!fs.existsSync(agentDir)) fs.mkdirSync(agentDir, { recursive: true });

    // ── 2. Persistence — SQLite checkpointer ────────────────────────────────
    // Persists the full conversation state between sessions.
    // REQUIRED for built-in features like human-in-the-loop to work.
    const dbPath = path.join(agentDir, 'deep_agent_history.db');
    const checkpointer = SqliteSaver.fromConnString(dbPath);

    // ── 3. System Prompt ────────────────────────────────────────────────────
    const systemPrompt = `You are a Principal Software Engineer specialized in NestJS (Node.js).
You operate directly on the local file system of a live, real-world project at: ${rootDir}

💎 QUALITY STANDARDS (UNBREAKABLE):
- Architecture: Follow DDD (Domain-Driven Design) and NestJS best practices.
- Strict TypeScript: The use of \`any\` is FORBIDDEN.
- Always document with TSDocs (prefer technical English).
- Testing (TDD): DO NOT write code without its corresponding .spec.ts test.

📋 PLANNING PROTOCOL (MANDATORY):
Before starting ANY task with more than one step:
1. Call \`write_todos\` to create a structured, numbered plan.
2. Execute each step in order, calling \`update_todo\` when a step is done.
3. If you lose track of progress, call \`read_todos\` to re-orient yourself.
4. NEVER skip the planning step on complex tasks — it prevents loops and missed steps.

🔍 CODE REFINEMENT — THE SURGEON'S RULE:
1. Read-Before-Write: NEVER overwrite a file without reading it first with \`safe_read_file\`.
2. Preservation First: Do not delete TSDocs, existing logic, or unrelated code.
3. Anti-Regression: Understand why code exists before removing it.

🧪 TESTING PROTOCOL (MANDATORY):
1. Spec First: Create the .spec.ts file alongside every new feature.
2. Verify Logic: After \`safe_write_file\`, run \`run_tests\` for that specific file.
3. No Regressions: Run \`run_integrity_check\` before finishing a task.
4. Auto-Fix: If tests fail, analyze, re-read, and self-correct. Max 3 attempts, then ask for help.

📂 EXPLORATION STRATEGY:
- Use \`ask_codebase\` for semantic RAG search of the codebase.
- Use \`list_files\` for directory structure inspection.
- Use \`safe_read_file\` to read actual file contents before modifying.
- After writes, call \`refresh_project_index\` if RAG results seem stale.

🚨 SAFETY RULES:
- Never perform mass file deletions.
- When modifying core files (app.module.ts), double-check all imports.
- Use RELATIVE PATHS for all file operations (e.g., 'src/users/users.service.ts').
- After 3 failed self-correction attempts, use \`ask_human\` to request guidance.`;

    // ── 4. Sync RAG index before starting ───────────────────────────────────
    if (interaction) {
      const indexerTask = interaction.startTask('Syncing codebase index...');
      await new IndexerService().indexProject();
      indexerTask.succeed('Codebase index synced ✅');
    } else {
      await new IndexerService().indexProject();
    }

    // ── 6. Register Gemini-compatible harness profile ───────────────────────
    // deepagents resolves the harness profile using the exact model string passed
    // as `spec` (line 7970 in index.cjs: getHarnessProfile(spec) ?? EMPTY).
    // Since we pass "gemini-2.5-flash-lite" (no colon), it's looked up as-is.
    // We register the exact model string as the key to exclude grep/glob —
    // both use Zod union/optional types incompatible with Gemini's schema converter.
    const geminiExclusions = { excludedTools: ['grep', 'glob'] };
    registerHarnessProfile(model, geminiExclusions);
    // Also cover the google-genai:model format in case deepagents normalizes it
    registerHarnessProfile(`google-genai:${model}`, geminiExclusions);

    // ── 7. Create the Deep Agent ─────────────────────────────────────────────
    // NOTE: No `backend` param — see ADR-001 in class JSDoc above.
    // write_todos, read_todos, ask_human are provided automatically by createDeepAgent.
    // Filesystem tools come from our custom tools that use SafeFilesystemBackend.
    const agent = createDeepAgent({
      model,
      systemPrompt,
      // ADR-002: Cast to any — dual @langchain/core version boundary.
      checkpointer: checkpointer as any,
      // ADR-002: Cast to any[] — DynamicStructuredTool type boundary.
      tools: [
        // 📂 Filesystem — safe wrappers with backup-before-write logic
        safeWriteFileTool,
        safeReadFileTool,
        listFilesTool,
        // 🔍 RAG — Semantic codebase search
        askCodebaseTool,
        // 🔄 RAG — Refresh vector index after writes
        refreshIndexTool,
        // ✅ Quality — TypeScript compilation + lint check
        integrityCheckTool,
        // 🧪 Testing — Run Jest tests
        executeTestsTool,
      ] as any[],
    });

    // ── 8. Patch Gemini-incompatible tool schemas ────────────────────────────
    // Gemini rejects Zod union types (anyOf/oneOf). The built-in `grep` and `glob`
    // tools from deepagents use optional union params. We replace their schemas
    // with flat, Gemini-compatible equivalents. This runs after createDeepAgent
    // so we can access the assembled tool list.
    const agentTools: any[] = (agent as any).tools ?? [];
    for (const tool of agentTools) {
      if (tool.name === 'grep') {
        // Replace the complex union schema with a flat Gemini-compatible schema
        const { z: zod } = await import('zod');
        tool.schema = zod.object({
          pattern: zod.string().describe('Regex pattern to search for in file contents'),
          path: zod.string().optional().describe('Base directory path to search from (default: project root)'),
          glob: zod.string().optional().describe('Glob pattern to filter files (e.g., "*.ts")'),
        });
      }
      if (tool.name === 'glob') {
        const { z: zod } = await import('zod');
        tool.schema = zod.object({
          pattern: zod.string().describe('Glob pattern to match files (e.g., "**/*.ts")'),
          path: zod.string().optional().describe('Base directory path to search from (default: project root)'),
        });
      }
    }

    return agent;
  }
}

