import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import { agentPath } from './agent-directory';

const roleModelsSchema = z
  .object({
    supervisor: z.string().trim().min(1).default('gemini-2.5-flash-lite'),
    researcher: z.string().trim().min(1).default('gemini-2.5-flash-lite'),
    coder: z.string().trim().min(1).default('gemini-2.5-pro'),
    verifier: z.string().trim().min(1).default('gemini-2.5-flash-lite'),
    summarizer: z.string().trim().min(1).default('gemini-2.5-flash-lite'),
  })
  .strict()
  .default({
    supervisor: 'gemini-2.5-flash-lite',
    researcher: 'gemini-2.5-flash-lite',
    coder: 'gemini-2.5-pro',
    verifier: 'gemini-2.5-flash-lite',
    summarizer: 'gemini-2.5-flash-lite',
  });

const limitsSchema = z
  .object({
    /** The approved policy permits at most two automatic correction cycles. */
    maxRetries: z.number().int().min(0).max(2).default(2),
    /** Nested delegation is intentionally disabled in the first iteration. */
    maxDelegationDepth: z.literal(1).default(1),
    /**
     * Caps LangGraph transitions for a single request. Fifty permits a
     * grounded investigation to reach a final answer while sixty remains a
     * hard stop for repeated tool cycles.
     */
    maxAgentTurns: z.number().int().min(1).max(60).default(50),
    /** Optional budget cap; omitted means pricing is observed but not enforced. */
    maxCostUsd: z.number().positive().optional(),
  })
  .strict()
  .default({
    maxRetries: 2,
    maxDelegationDepth: 1,
    maxAgentTurns: 50,
  });

const permissionsSchema = z
  .object({
    /** Only the Coder may write during a task. */
    singleWriter: z.boolean().default(true),
    /** Safe code edits/tests may run without a prompt. */
    autoApproveSafeEdits: z.boolean().default(true),
    /** External network, secrets, infrastructure and destructive actions require approval. */
    requireApprovalForExternalActions: z.boolean().default(true),
  })
  .strict()
  .default({
    singleWriter: true,
    autoApproveSafeEdits: true,
    requireApprovalForExternalActions: true,
  });

const ragSchema = z
  .object({
    /**
     * Which embedding provider builds and reads the code index.
     *
     * `vertex` remains the default so that an existing installation behaves
     * exactly as it did before embeddings became pluggable (ADR-025). `ollama`
     * runs locally: no credentials, no per-query cost, works offline.
     *
     * Switching does not discard the previous provider's vectors — they live in
     * separate columns of `code_chunks` — so switching back requires no
     * reindex.
     */
    embeddings: z.enum(['vertex', 'ollama']).default('vertex'),
    /** Optional model override for the selected provider. */
    embeddingsModel: z.string().trim().min(1).optional(),
  })
  .strict()
  .default({ embeddings: 'vertex' });

const agentConfigSchema = z.object({
  models: roleModelsSchema,
  limits: limitsSchema,
  permissions: permissionsSchema,
  rag: ragSchema,
}).strict();

/** Runtime configuration for adaptive multi-agent execution. */
export type AgentConfig = z.infer<typeof agentConfigSchema>;

/** Input shape accepted by the parser, with defaults allowed to be omitted. */
export type AgentConfigInput = z.input<typeof agentConfigSchema>;

/** Result returned by the idempotent project initialization helper. */
export interface AgentConfigInitResult {
  /** Absolute path of the local runtime policy file. */
  path: string;
  /** Whether this invocation created the file. */
  created: boolean;
  /** Validated policy currently present on disk. */
  config: AgentConfig;
}

/**
 * Parses and validates project agent configuration.
 *
 * Unknown keys are rejected explicitly so typos do not silently change runtime
 * policy.
 *
 * @param input - Configuration loaded from a project file or environment.
 * @returns A fully defaulted and validated configuration.
 * @throws {z.ZodError} When a model name or safety limit is invalid.
 */
export function parseAgentConfig(input: unknown): AgentConfig {
  return agentConfigSchema.parse(input);
}

/**
 * Loads the optional project-local runtime policy.
 *
 * The file intentionally lives under `.umbra/`, which `ensureAgentStateIgnored`
 * keeps out of git because it can contain local model choices, budgets, and
 * other machine-specific settings.
 * Missing configuration is safe and returns the same defaults as `parseAgentConfig({})`.
 *
 * @param rootDir - Project root containing the `.umbra` directory.
 * @returns A validated, fully defaulted runtime policy.
 * @throws {Error} When the file contains invalid JSON or violates the policy schema.
 */
export function loadAgentConfig(rootDir: string): AgentConfig {
  const configPath = agentPath(rootDir, 'agent.config.json');
  if (!fs.existsSync(configPath)) return parseAgentConfig({});

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as unknown;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid agent configuration at ${configPath}: ${message}`);
  }

  return parseAgentConfig(parsed);
}

/**
 * Creates the project-local runtime policy when it does not exist.
 *
 * This operation is intentionally idempotent and never overwrites an existing
 * policy. It is the implementation behind the `umbra init` command.
 *
 * @param rootDir - Project root that receives the `.umbra` directory.
 * @returns Path, creation status, and validated configuration.
 */
export function ensureAgentConfig(rootDir: string): AgentConfigInitResult {
  const configPath = agentPath(rootDir, 'agent.config.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });

  if (fs.existsSync(configPath)) {
    return { path: configPath, created: false, config: loadAgentConfig(rootDir) };
  }

  const config = parseAgentConfig({});
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  return { path: configPath, created: true, config };
}
