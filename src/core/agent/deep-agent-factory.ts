import {
  createDeepAgent,
  registerHarnessProfile,
} from 'deepagents';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { InteractionService } from '../interaction';
import { IndexerService } from '../rag/indexer';
import {
  resolveConfiguredModel,
  resolveModelForSession,
  isGeminiModel,
  isOllamaModel,
  isVertexAnthropicModel,
} from '../config/model-resolver';
import {
  askCodebaseTool,
  executeTestsTool,
  integrityCheckTool,
  refreshIndexTool,
  safeWriteFileTool,
  safeReadFileTool,
  deleteFileTool,
  listFilesTool,
  listAdrsTool,
} from '../tools';
import { createResearcherSubAgent } from '../subagents/researcher.subagent';
import { createCoderSubAgent } from '../subagents/coder.subagent';
import { createVerifierSubAgent } from '../subagents/verifier.subagent';
import {
  AgentConfig,
  AgentConfigInput,
  loadAgentConfig,
  parseAgentConfig,
} from '../config/agent-config';
import { buildEvidenceProtocolPrompt } from './evidence-protocol';
import { groundedAnalysisSchema } from './evidence-protocol';
import { collectWorkspaceEvidence, formatWorkspaceEvidence } from './workspace-evidence';
import { LLMProvider } from '../llm/provider';
import { OllamaChatAdapter } from '../llm/ollama-adapter';
import { buildOllamaWarning } from '../../presentation/cli/theme';
import { createOrchestrationGuard } from './orchestration-guard.middleware';
import { buildSubagentGraphs } from './delegation/subagent-registry';
import { createDelegateTool } from './delegation/delegate.tool';
import {
  DEFAULT_INTERACTIVE_TOOL_BUDGET,
  createIterationBudgetMiddleware,
} from './iteration-budget.middleware';
import type { CostResolver } from './turn-governor';
import { LlmPricingConfig } from '../infrastructure/config/llm-pricing.config';
import { CostTrackerService } from '../application/services/cost-tracker.service';
import { TokenUsage } from '../domain/value-objects/token-usage';
import * as path from 'path';
import * as fs from 'fs';
import {
  AGENT_DIR_NAME,
  LEGACY_AGENT_DIR_NAME,
  agentPath,
  migrateLegacyAgentDirectory,
} from '../config/agent-directory';
import { ensureAgentStateIgnored } from '../config/workspace-scaffold';

/** Built-in filesystem tools replaced by Umbra's guarded, Windows-safe tools. */
const REPLACED_BUILTIN_TOOLS = [
  'grep', 'glob', 'ls', 'read_file', 'write_file', 'edit_file',
] as const;

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
   * Resolution priority: this explicit value > AGENT_MODEL env var > role profile.
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

  /**
   * Optional project policy override. When omitted, `.umbra/agent.config.json`
   * is loaded; when both are absent, safe defaults are used.
   */
  agentConfig?: AgentConfigInput;
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
   * Includes: write_todos, safe filesystem tools, RAG tools. Actions the
   * security policy gates raise an operator approval prompt on their own.
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
    const agentConfig = DeepAgentFactory.resolveAgentConfig(rootDir, config.agentConfig);
    const model = resolveModelForSession(agentConfig.models.supervisor, config.model);

    await DeepAgentFactory.bootstrap(rootDir, model, interaction);

    const checkpointer = DeepAgentFactory.buildCheckpointer(rootDir);
    const systemPrompt = DeepAgentFactory.buildSystemPrompt(rootDir, 'simple', agentConfig);

    const modelParam = DeepAgentFactory.resolveRuntimeModel(model);

    return createDeepAgent({
      model: modelParam as any,
      systemPrompt,
      checkpointer: checkpointer as any, // ADR-002
      middleware: [createIterationBudgetMiddleware(DEFAULT_INTERACTIVE_TOOL_BUDGET, rootDir, {
        limits: { maxCostUsd: agentConfig.limits.maxCostUsd },
        costOf: DeepAgentFactory.buildCostResolver(model),
      })],
      tools: [                           // ADR-002
        safeWriteFileTool,
        safeReadFileTool,
        // Gated by the security policy: every delete raises a HITL interrupt
        // that ChatSession renders for the operator (ADR-011).
        deleteFileTool,
        listFilesTool,
        listAdrsTool,
        askCodebaseTool,
        refreshIndexTool,
        integrityCheckTool,
        executeTestsTool,
      ] as any[],
    });
  }

  /**
   * Creates a one-shot, read-only analysis agent with structured output.
   *
   * Unlike the conversational `create()` mode, this mode injects a bounded
   * machine-collected evidence manifest and requires every finding to carry a
   * project-relative citation. It is intended for architecture reviews,
   * project audits, performance assessments, and the `/analyze` CLI command.
   *
   * @param config - Optional model, project, and policy overrides.
   * @param interaction - Optional interaction service for CLI task indicators.
   * @returns A compiled read-only DeepAgent with grounded structured output.
   */
  // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
  public static async createAnalysis(
    config: DeepAgentFactoryConfig = {},
    interaction?: InteractionService,
  ): Promise<any> {
    const rootDir = config.rootDir ?? process.cwd();
    const agentConfig = DeepAgentFactory.resolveAgentConfig(rootDir, config.agentConfig);
    const model = resolveModelForSession(agentConfig.models.researcher, config.model);

    await DeepAgentFactory.bootstrap(rootDir, model, interaction);

    const checkpointer = DeepAgentFactory.buildCheckpointer(rootDir, 'analysis');
    const evidence = formatWorkspaceEvidence(collectWorkspaceEvidence(rootDir));
    const systemPrompt = DeepAgentFactory.buildSystemPrompt(
      rootDir,
      'analysis',
      agentConfig,
      evidence,
    );
    const modelParam = DeepAgentFactory.resolveRuntimeModel(model);

    return createDeepAgent({
      model: modelParam as any,
      systemPrompt,
      responseFormat: groundedAnalysisSchema as any, // ADR-002: dual Zod package boundary
      checkpointer: checkpointer as any, // ADR-002
      // Analysis is intentionally manifest-only: small models otherwise keep
      // rereading files already represented in the bounded evidence, consuming
      // turns and polluting the one-shot context. Regular deep/orchestrator
      // modes retain focused reads and RAG for interactive work.
      tools: [] as any[],
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
    const agentConfig = DeepAgentFactory.resolveAgentConfig(rootDir, config.agentConfig);
    const model = resolveModelForSession(agentConfig.models.supervisor, config.model);
    const enableCompression = config.enableContextCompression ?? true;

    // hasSubagents: this mode registers researcher/coder/verifier, so `task`
    // must reach the provider (ADR-013).
    await DeepAgentFactory.bootstrap(rootDir, model, interaction, false);

    const checkpointer = DeepAgentFactory.buildCheckpointer(rootDir, 'orchestrator');
    const systemPrompt = DeepAgentFactory.buildSystemPrompt(rootDir, 'orchestrator', agentConfig);

    // Same Ollama adapter pattern as create() — pass BaseChatModel for Ollama,
    // string for Vertex AI.
    const modelParam = DeepAgentFactory.resolveRuntimeModel(model);

    // The delegates are compiled here rather than handed to deepagents, because
    // the delegation tool's schema is the mandate and a tool with our schema has
    // to own its dispatch (ADR-021).
    const delegateTool = createDelegateTool(buildSubagentGraphs({
      researcher: createResearcherSubAgent(DeepAgentFactory.resolveRoleModel(agentConfig.models.researcher)),
      coder: createCoderSubAgent(DeepAgentFactory.resolveRoleModel(agentConfig.models.coder)),
      verifier: createVerifierSubAgent(DeepAgentFactory.resolveRoleModel(agentConfig.models.verifier)),
    }));

    return createDeepAgent({
      model: modelParam as any,
      systemPrompt,
      checkpointer: checkpointer as any, // ADR-002
      middleware: [createOrchestrationGuard({
        maxRetries: agentConfig.limits.maxRetries,
        maxAgentTurns: agentConfig.limits.maxAgentTurns,
      })] as any[],
      tools: [                           // ADR-002
        askCodebaseTool,
        refreshIndexTool,
        integrityCheckTool,
        delegateTool,
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
    hasSubagents = false,
  ): Promise<void> {
    // 1. Setup the workspace directory
    //
    // A project last used before the rename still holds `.agent/`, with its RAG
    // index, session history and backups inside. Moving it here — before
    // anything reads or writes the workspace — is what makes the rename a
    // rename rather than a silent reset to an empty index.
    const migration = migrateLegacyAgentDirectory(rootDir);
    if (migration.migrated) {
      interaction?.logInfo(
        `Workspace moved: ${LEGACY_AGENT_DIR_NAME}/ → ${AGENT_DIR_NAME}/ (index and history preserved)`,
      );
    } else if (migration.reason === 'both-exist') {
      interaction?.logInfo(
        `Both ${LEGACY_AGENT_DIR_NAME}/ and ${AGENT_DIR_NAME}/ exist; using ${AGENT_DIR_NAME}/. ` +
        `The old directory was left untouched — delete it once you are sure.`,
      );
    }

    const agentDir = agentPath(rootDir);
    if (!fs.existsSync(agentDir)) fs.mkdirSync(agentDir, { recursive: true });

    // The ignore rules are ensured here, not only in `umbra init`.
    //
    // A project that had the previous directory ignored keeps a rule naming a
    // directory that no longer exists once the migration above runs, which
    // leaves the new one exposed. That is not hypothetical: it happened to
    // Umbra's own repository, and a 199 MB session database reached a commit
    // before GitHub's file-size limit rejected the push.
    //
    // Appending only what is missing makes this a no-op on every later start.
    const addedRules = ensureAgentStateIgnored(rootDir);
    if (addedRules.length > 0) {
      interaction?.logInfo(`Added to .gitignore: ${addedRules.join(', ')}`);
    }

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
    //
    // ADR-013: `task` is excluded only when this agent has NO subagents. It used
    // to be excluded unconditionally, on both providers, which silently removed
    // the orchestrator's only way to delegate: the prompt ordered it to route
    // through `task`, the provider never received the declaration, and the model
    // invented the call with guessed argument names.
    const taskExclusions = hasSubagents ? [] : ['task'];
    if (isGeminiModel(model)) {
      DeepAgentFactory.registerGeminiHarnessProfile(model, taskExclusions);
    } else if (isVertexAnthropicModel(model)) {
      DeepAgentFactory.registerAnthropicHarnessProfile(taskExclusions);
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
        excludedTools: [
          ...REPLACED_BUILTIN_TOOLS,
          ...taskExclusions,
        ],
      });

      // ADR-022: Preflight check + model warmup for Ollama (CPU/RAM pressure)
      //
      // WHY: On CPU-only machines, Ollama can take 2–5 min to swap/load an 8B
      // model. If deepagents fires the first inference during this load, its
      // internal fetch timeout fires first → confusing `fetch failed` error.
      //
      // FIX:
      //   1. Run preflight (query /api/ps) to show a RAM warning if multiple
      //      models are loaded (model swap will occur).
      //   2. Run warmup (1-token generation) to force the model into RAM before
      //      deepagents makes its real request.
      //   3. The OllamaChatAdapter timeout is already 5 min (constructor).
      //
      // Both are best-effort (failures are logged, not thrown).
      await DeepAgentFactory.runOllamaPreflight(model, interaction);
    }

    // 3. Sync RAG index (lazy — skips if index is fresh < 5 min)
    // NOTE: RAG embeddings always use Vertex AI (text-embedding-004), even for
    // Ollama chat models. If Vertex credentials are missing, indexing is skipped
    // gracefully — the agent can still function without semantic search.
    await DeepAgentFactory.maybeReindex(rootDir, interaction);
  }

  /**
   * Resolves the project policy from an explicit override or local runtime file.
   *
   * @param rootDir - Project root used to locate `.umbra/agent.config.json`.
   * @param input - Optional programmatic policy override.
   * @returns A fully defaulted and validated policy.
   */
  private static resolveAgentConfig(
    rootDir: string,
    input?: AgentConfigInput,
  ): AgentConfig {
    return input === undefined ? loadAgentConfig(rootDir) : parseAgentConfig(input);
  }

  /**
   * Creates the runtime model instance used by deepagents.
   *
   * Routing every provider through LLMProvider is required so Gemini receives
   * the configured Vertex location instead of a deepagents implicit default.
   *
   * @param model - Resolved model identifier.
   * @returns A configured LangChain chat model.
   */
  private static resolveRuntimeModel(model: string) {
    return LLMProvider.createChatModel(model);
  }

  /**
   * Resolves a role model without applying the global AGENT_MODEL override.
   *
   * @param configuredModel - Model configured for the role.
   * @returns A configured LangChain chat model.
   */
  private static resolveRoleModel(configuredModel: string) {
    return DeepAgentFactory.resolveRuntimeModel(
      resolveConfiguredModel(configuredModel),
    );
  }

  /**
   * Registers Gemini exclusions for string and pre-built Vertex model paths.
   *
   * @param model - Resolved Gemini model identifier.
   * @returns Nothing.
   */
  private static registerGeminiHarnessProfile(
    model: string,
    taskExclusions: string[] = ['task'],
  ): void {
    const unsafeTools = DeepAgentFactory.detectGeminiIncompatibleTools();
    const excludedTools = [...new Set([...unsafeTools, ...taskExclusions])];

    registerHarnessProfile(model, { excludedTools });
    registerHarnessProfile(`google:${model}`, { excludedTools });
  }

  /**
   * Registers provider-wide exclusions for Claude models.
   *
   * A base `anthropic` profile composes with DeepAgents' exact built-in Claude
   * profiles, preserving their prompt guidance while replacing unsafe built-in
   * filesystem tools with Umbra's guarded equivalents. `task` is excluded only
   * when the current agent has no subagents.
   *
   * @param taskExclusions - Delegation exclusions for the current topology.
   * @returns Nothing.
   */
  private static registerAnthropicHarnessProfile(
    taskExclusions: string[] = ['task'],
  ): void {
    registerHarnessProfile('anthropic', {
      excludedTools: [...REPLACED_BUILTIN_TOOLS, ...taskExclusions],
    });
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

  /**
   * Runs the Ollama preflight check and model warmup for CPU-only environments.
   *
   * Execution order:
   * 1. Calls `OllamaChatAdapter.preflight()` to query `/api/ps` for currently
   *    loaded models and assess RAM pressure.
   * 2. Prints a styled warning via `buildOllamaWarning()` if models are loaded
   *    (swap will occur) or always (to set latency expectations on CPU).
   * 3. Calls `OllamaChatAdapter.warmup()` with a progress callback that logs
   *    a reassurance message every 15s (e.g. "Still loading... 30s elapsed").
   *    This forces the model into RAM before deepagents makes its first call,
   *    preventing the `fetch failed` timeout on model-swap.
   *
   * Both steps are **best-effort**: failures are caught and logged, never thrown.
   * The agent startup continues regardless of preflight/warmup outcome.
   *
   * @param model - Full model string with `ollama:` prefix (e.g. "ollama:gemma4:e4b").
   * @param interaction - Optional interaction service for spinner integration.
   */
  private static async runOllamaPreflight(
    model: string,
    interaction?: InteractionService,
  ): Promise<void> {
    const baseUrl = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
    // Strip the "ollama:" prefix to get the bare model name Ollama expects
    const bareModel = model.startsWith('ollama:') ? model.slice('ollama:'.length) : model;

    // ── Step 1: Preflight — query /api/ps ───────────────────────────────────
    let preflight: Awaited<ReturnType<typeof OllamaChatAdapter.preflight>>;
    try {
      preflight = await OllamaChatAdapter.preflight(baseUrl);
    } catch {
      // If preflight itself throws (shouldn't — it already handles errors), continue
      preflight = { ollamaReachable: false, loadedModels: [], totalLoadedBytes: 0, requiresSwap: false, estimatedModelBytes: 0 };
    }

    // ── Step 2: Print RAM warning ────────────────────────────────────────────
    process.stdout.write(
      buildOllamaWarning({
        model: bareModel,
        loadedModels: preflight.loadedModels,
        requiresSwap: preflight.requiresSwap,
      }),
    );

    // ── Step 3: Warmup — force model into RAM ────────────────────────────────
    const warmupTask = interaction
      ? interaction.startTask(`Warming up ${bareModel}...`)
      : null;

    const succeeded = await OllamaChatAdapter.warmup(
      bareModel,
      baseUrl,
      (elapsedMs: number) => {
        const elapsedSec = Math.round(elapsedMs / 1000);
        const msg = `Still loading ${bareModel}... ${elapsedSec}s elapsed (CPU mode, this is normal)`;
        if (warmupTask) {
          warmupTask.update(msg);
        } else {
          process.stdout.write(`  ⏳ ${msg}\n`);
        }
      },
    );

    if (warmupTask) {
      if (succeeded) {
        warmupTask.succeed(`${bareModel} loaded ✓ — ready for inference`);
      } else {
        // TaskIndicator has no .warn() — use .fail() for the non-fatal warning
        warmupTask.fail(`Warmup timed out for ${bareModel} — first response may be slow`);
      }
    } else if (!succeeded) {
      process.stdout.write(`  ⚠️  Warmup timed out for ${bareModel}. First response may be slow.\n`);
    }
  }

  private static detectGeminiIncompatibleTools(): string[] {

    // Known always-problematic tools — hard-coded baseline (NEVER remove these).
    // grep, glob: Zod union types → Gemini rejects their schema at parse time.
    // ls, read_file, write_file, edit_file: Windows path bugs + no backup safety.
    // The auto-scan below catches any FUTURE tools deepagents may add with union types.
    const baselineExcluded: string[] = [...REPLACED_BUILTIN_TOOLS];

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
   * Clears the persisted checkpoints for a corrupted thread.
   *
   * When Vertex AI returns "must include at least one parts field", it means the
   * SQLite checkpoint contains a message with empty content — usually from a tool
   * call that was interrupted mid-flight (e.g., Ctrl+C during a streaming tool call).
   *
   * LangGraph does not expose a safe partial rollback for a terminal tool result.
   * Resetting the named thread prevents the invalid tool-only history from being
   * combined with a later human message.
   *
   * @param rootDir - Project root directory (where `.umbra/` lives).
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
    const dbPath = agentPath(rootDir, dbFile);

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
   * Reads `.umbra/index.meta.json` to check the last index timestamp.
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
    // Ollama-only users will have neither a service account nor local ADC.
    // The agent still works — it just won't have semantic RAG search.
    if (!LLMProvider.hasVertexCredentials()) {
      if (interaction) {
        interaction
          .startTask('RAG index skipped (no Vertex credentials)')
          .succeed('RAG index skipped — Ollama mode (no Google credentials)');
      }
      return;
    }

    /** Maximum age (ms) before the index is considered stale and rebuilt. */
    const FRESH_TTL_MS = 5 * 60 * 1000; // 5 minutes
    const metaPath = agentPath(rootDir, 'index.meta.json');

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
    type: 'simple' | 'orchestrator' | 'analysis' = 'simple',
  ): SqliteSaver {
    const agentDir = agentPath(rootDir);
    const dbFile = type === 'orchestrator'
      ? 'orchestrator_history.db'
      : type === 'analysis'
        ? 'analysis_history.db'
        : 'deep_agent_history.db';
    const dbPath = path.join(agentDir, dbFile);
    return SqliteSaver.fromConnString(dbPath);
  }

  /**
   * Builds the pricing function that enables the turn governor's cost ceiling.
   *
   * `agent.config.json` has declared `limits.maxCostUsd` since the schema was
   * written, and until now nothing read it. Enforcing it needs a price, and a
   * price the project does not have must disable the ceiling rather than
   * silently treat the turn as free — which is exactly how cost tracking came
   * to report zero for the starred default model.
   *
   * @param model - Model whose published price applies to this session.
   * @returns A resolver returning USD, or `undefined` when the model is unpriced.
   */
  private static buildCostResolver(model: string): CostResolver {
    const tracker = new CostTrackerService(new LlmPricingConfig());

    return (usage) => {
      try {
        return tracker
          .calculateCost(model, new TokenUsage(usage.inputTokens, usage.outputTokens))
          .amount;
      } catch {
        return undefined;
      }
    };
  }

  /**
   * Builds the system prompt for the given agent type.
   *
   * @param rootDir - The project root directory (injected into prompt for context).
   * @param type - The agent type ('simple' | 'orchestrator' | 'analysis').
   * @param agentConfig - Validated project execution policy.
   * @param evidenceManifest - Optional bounded workspace evidence for analysis mode.
   * @returns The system prompt string.
   */
  private static buildSystemPrompt(
    rootDir: string,
    type: 'simple' | 'orchestrator' | 'analysis',
    agentConfig: AgentConfig = parseAgentConfig({}),
    evidenceManifest = '',
  ): string {
    const evidenceProtocol = buildEvidenceProtocolPrompt(
      type === 'analysis' ? 'preloaded-manifest' : 'tool-research',
    );
    const base = `You are a Principal Software Engineer specialized in NestJS (Node.js).
You operate directly on the local file system of a live, real-world project at: ${rootDir}

💬 CONVERSATION GATE — this takes precedence over every protocol below:
If the message asks for no work — a greeting, an acknowledgement, a thank you, or
a one-line remark with no question about this project — answer it in one or two
sentences and call no tools at all. The protocols below describe how to carry out
work; they begin to apply at the first message that asks for some, not before.

${evidenceProtocol}
🎯 SKILL DISCOVERY — before starting a task:
Scan the user's message for trigger keywords and load the matching skill first.

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
- "mentor / teach me / explain why / trade-off / learning" → \`skills/mentor-mode.md\`
- "ADR / decision record / document this decision / supersede" → \`skills/document-decision.md\`

If no keyword matches, load no skill and proceed with your best NestJS/DDD
judgment. The map above is the complete list, so listing the directory discovers
nothing and costs a round trip — which is how the word "hey" once cost 11 tool
calls before answering.
Load a matching skill with \`safe_read_file("skills/<name>.md")\` and follow it precisely.
A consumer project may ship no \`skills/\` directory at all; that is expected, not a
problem to investigate.

ARCHITECTURE DECISION INDEX:
- Do not scan or read ADR files during ordinary coding tasks.
- Only when a prior architecture decision, model policy, safety boundary, or project history is relevant,
  call \`list_adrs\` first. It returns only paths, title, status, and compact context.
- Then use \`safe_read_file\` on the one ADR that is relevant to the task; never load all ADRs.
- WRITING one is conditional, never automatic. Load \`skills/document-decision.md\` and record a
  decision in this project's \`docs/adr/\` only when the finished work moved a layer boundary,
  a persistence or migration strategy, an auth/safety boundary, a public contract (DTO, interface,
  endpoint), a provider or library choice, or accepted a knowing trade-off in cost or consistency.
- Routine refactors, renames, bug fixes with one obvious answer, and reversible local choices get
  NO ADR. Never write a record to satisfy a format; a folder of trivial ADRs buries the real ones.

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

🔍 SESSION STATE VERIFICATION — when the work depends on earlier file changes:
History is a record of intent — disk is ground truth.
- If history mentions files you created before → verify with \`safe_read_file\` before assuming.
- If a file is missing → create it from scratch. Never skip a write because history says it was done.

🚨 FILE CREATION LAW:
Describing a file ≠ creating it. A file only exists on disk after \`safe_write_file\` is called.
- After EVERY \`safe_write_file\` → immediately verify with \`safe_read_file\`. Count your writes.
- Never mark a todo step done until disk confirmation.

🛑 SAFETY RULES (universal — apply to every task):
- Deleting a file always raises an operator approval prompt on its own; never
  assume a delete happened until the tool result confirms it.
- Never write outside the project root. Use RELATIVE PATHS only.
- Read-Before-Write: always \`safe_read_file\` before overwriting any existing file.
- Tolerate typos, bad grammar, Spanglish — always infer intent, never reject a request.
- After the configured correction cycles → stop and report what is blocking you
  instead of retrying.

📝 OUTPUT FORMAT (always markdown):
Use \`# Headers\`, \`**bold**\` for key terms, fenced code blocks with language tags.
Never respond in plain prose. Even short answers must use **bold** for key terms.

🎓 MENTOR MODE — ALWAYS ON (lightweight):
After every fix, implementation, or architectural decision, include:
- **Root Cause** (bugs): why it broke — not just what, but WHY
- **Why this approach**: why chosen over alternatives for significant decisions
- **Trade-off**: what's accepted or limited by this choice

For changes touching >5 files OR public API contracts (DTOs, interfaces):
State the plan and its impact in your answer BEFORE implementing, so the operator
can stop you before the first write.

Format: "The problem was X because Y. I solved it with Z because [reason]. Trade-off: [limitation]."
For architecture: "I chose [pattern] over [alternative] because [reason]. Downside: [trade-off]."

For deep explanations, load \`skills/mentor-mode.md\` (triggered by keywords: mentor, teach me, explain why, trade-off).`;

    const policy = `

🔐 EXECUTION POLICY (validated project configuration):
- Role models: supervisor=${agentConfig.models.supervisor}, researcher=${agentConfig.models.researcher}, coder=${agentConfig.models.coder}, verifier=${agentConfig.models.verifier}.
- Maximum automatic correction cycles: ${agentConfig.limits.maxRetries}.
- Delegation depth is limited to ${agentConfig.limits.maxDelegationDepth}; do not spawn nested subagents.
- Only the Coder may write during delegated work: ${agentConfig.permissions.singleWriter}.
- Safe edits may proceed automatically: ${agentConfig.permissions.autoApproveSafeEdits}.
- External, destructive, secret, infrastructure, Git push, and deployment actions require approval: ${agentConfig.permissions.requireApprovalForExternalActions}.
Keep handoffs compact; never copy full subagent transcripts into your working context.`;

    if (type === 'simple') {
      return base + policy + `

⚡ TASK SIZING — classify before acting:
- **SMALL** (1-2 files, obvious change): No \`write_todos\`. Read → Write → Done. Max 3 tool calls.
- **MEDIUM** (3+ files, new feature): Use \`write_todos\` with 3-5 steps.
- **LARGE** (full module, major refactor): Full \`write_todos\` plan before starting.

⏱️ INTERACTIVE INVESTIGATION BUDGET:
- Prefer direct evidence reads over repeated semantic searches. Do not repeat an equivalent tool query.
- Aim to complete a read-only investigation within 8 tool calls. When enough evidence exists, stop exploring and answer with the paths already verified.
- If the available evidence is insufficient, state the uncertainty and the next exact file to inspect; do not spend the remaining budget searching broadly.

📋 PLANNING TOOL NAMES (exact, case-sensitive):
- \`write_todos\`  ← create the plan
- \`read_todos\`   ← re-read if you lose track
- \`update_todo\`  ← mark ONE step done (singular — NOT update_todos)

🤖 AUTONOMOUS EXECUTION:
Once you have a plan, execute ALL steps without stopping.
- Never ask "should I continue?" or wait for confirmation between steps.
- After each step: announce done + what comes next → immediately do it.
- Only stop when ALL todos are done OR a HITL gate fires.

🛑 GATED ACTIONS — the security policy stops these for operator approval by
itself; you do not request it, and you must not treat a refusal as retryable:
- Deleting files or directories
- Writing project configuration or CI files
- Writing anywhere outside src, test and docs
After the configured correction cycles, stop and report what is blocking you.
Everything else → execute autonomously.`;
    }

    if (type === 'analysis') {
      return base + policy + `

🎯 YOUR ROLE: EVIDENCE-GATED ANALYST
This is a read-only one-shot audit. Never write, delete, execute, or propose an
unverified repository fact. The response schema requires:
- summary: concise purpose and conclusion;
- findings: claims, each with confidence (high/medium/low) and at least one direct
  or retrieved citation containing a real relative path;
- unknowns: explicit "No verificado" items when the manifest or tools do not prove a claim;
- filesReferenced: every path used as evidence.

ONE-SHOT ANALYSIS OVERRIDE:
This override takes precedence over generic workflow instructions intended for interactive
agents. Do not call list_files, safe_read_file, ask_codebase, write_todos, or task.
Do not load a skill. The bounded manifest below replaces discovery for this report.
Return the structured answer directly after evaluating the supplied evidence.

The machine-collected manifest below is the complete evidence set for this one-shot
run. Do not request more files or tools: mark facts absent from it as "No verificado".
This mode intentionally does not use semantic RAG so broad audits remain stable,
low-cost, and bounded; do not invent evidence that is absent from the manifest.

${evidenceManifest}`;
    }


    // Orchestrator prompt
    return base + policy + `

🎯 YOUR ROLE: ORCHESTRATOR
You coordinate specialized subagents to complete complex tasks.
You do NOT implement code yourself — you delegate to the right specialist.

📋 MANDATORY ORCHESTRATION PROTOCOL:
Every interactive request carries a trusted \`[ORCHESTRATION_ROUTE ...]\` envelope generated
before it enters this graph. Obey it exactly:
- When \`implementation=false\`, do not call a subagent or write. Answer using read-only tools.
- When \`implementation=true\`, follow the required route in its exact order. The Coder is the
  only writer and uses its quality-oriented model profile.
- Call the registered task identifiers exactly as \`researcher\`, \`coder\`, and \`verifier\`
  (all lowercase). If a task result contains \`"status":"blocked"\` from the orchestration
  guard, STOP immediately: report its reason and do not draft code, simulate tests, or claim a
  change was made.

For implementation tasks, follow this exact sequence:
1. Call \`write_todos\` with the full plan (Analysis → Implementation → Verification).
2. Call \`delegate\` with subagent "researcher", passing a complete ORDER (see below).
3. Call \`delegate\` with subagent "coder", passing a complete ORDER that includes the
   researcher handoff in \`knownContext\`.
4. Call \`delegate\` with subagent "verifier" after the Coder finishes.
   - The verifier is read-only and runs focused tests plus the TypeScript integrity check.
5. If verification fails, allow at most the configured correction cycles, then call the verifier again.
6. Report to the user: what was built, decisions and trade-offs, changed files, evidence, risks, and next steps.

📦 EVERY DELEGATION CARRIES ITS ORDER — THIS IS NOT OPTIONAL
A delegate cannot see this conversation. It receives only the order you write in the
\`delegate\` call. Whatever you leave out, it cannot look up — it can only guess, and a
guessing delegate explores until its budget is gone.

\`delegate\` takes the order as its arguments:

  subagent          "researcher" | "coder" | "verifier"
  userRequest       the request of the user, copied word for word — never a paraphrase
  objective         what this delegate must achieve, in your words
  knownContext      what you already know, so it is not rediscovered
  inScope           what belongs to this delegation
  outOfScope        what must NOT be explored — optional, and the field that saves the most
  definitionOfDone  the artifact you expect back
  conventions       project rules and decision records that constrain the work

Fill \`outOfScope\` when you genuinely know a boundary. Never invent one: the delegate
will obey it.

🎚️ BUDGETS AND PARTIAL RESULTS
Each delegation is granted a share of one budget shared by this whole turn, and a
reserve is held back so you can always answer. Consequences you must handle:
- A delegate may return \`"status":"partial"\` with a populated \`unknowns\` list. That is a
  real result, not a failure. Never treat a partial research handoff as approval to
  implement: report what is known and what is missing.
- If a delegation is refused for lack of budget, do NOT delegate again. Answer with what
  has been established and state plainly what was not investigated.
- A delegate may ask a question through \`ask_delegator\`. It is answered from the order you
  wrote, or put to the operator. The better your order, the fewer interruptions.

🤖 AVAILABLE SUBAGENTS:
- **researcher**: Analyzes codebase, reads files, returns implementation plan. Use FIRST.
- **coder**: Implements code with TDD. Receives the researcher's handoff. Use SECOND.
- **verifier**: Runs tests and type-checks without write access. Use LAST.

📂 ORCHESTRATOR TOOLS:
- \`ask_codebase\`: For quick questions you can answer yourself without delegating.
- \`run_integrity_check\`: Final verification after coder finishes.
- \`refresh_project_index\`: If RAG seems stale after coder writes files.
- \`write_todos\`, \`delegate\`: Standard orchestration tools.`;
  }
}
