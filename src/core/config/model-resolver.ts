/**
 * @module ModelResolver
 *
 * Centralized LLM model resolution for the nestjs-ai-agent-lib.
 *
 * Primary-session resolution priority:
 * 1. Explicit CLI/programmatic override (highest — deliberate task choice)
 * 2. `AGENT_MODEL` environment variable (runtime switch)
 * 3. Role profile or `DEFAULT_MODEL` (safe fallback)
 *
 * Supported model string formats:
 * - Bare model name:      "gemini-2.5-flash-lite"   → Google Vertex AI / GenAI
 * - Claude on Vertex:     "vertex-anthropic:claude-sonnet-5"
 * - Direct provider:model:"anthropic:claude-opus-4-7" (reserved, unsupported)
 * - Ollama local:         "ollama:llama3.2"
 * - OpenAI format:        "openai:gpt-4o"
 *
 * @example
 * ```bash
 * # .env.development
 * AGENT_MODEL=gemini-2.5-flash-lite      # fast and cheap (default)
 * AGENT_MODEL=gemini-2.5-pro             # for architecture tasks
 * AGENT_MODEL=ollama:llama3.2            # local, no API costs
 * AGENT_MODEL=vertex-anthropic:claude-sonnet-5  # Claude through Vertex AI
 * ```
 *
 * @example
 * ```ts
 * const model = resolveModel(); // reads AGENT_MODEL env
 * const model = resolveModelForSession('gemini-2.5-pro', 'pro');
 * ```
 */

/** Default model used when no environment variable or override is set. */
export const DEFAULT_MODEL = 'gemini-2.5-flash-lite';

/**
 * Model tier shortcuts for ergonomic selection without memorizing full model names.
 * Maps a tier to the recommended model string for that use case.
 *
 * Tier aliases point to the **latest stable** generation by default.
 * Use the versioned aliases (e.g., `"2.5-flash"`) to pin to a specific family.
 */
export const MODEL_TIERS: Record<string, string> = {
  // ── Tier shortcuts (always point to latest recommended) ──────────────────
  /** Quick tasks, cheap. Best for: classification, routing, intent detection. */
  lite:  'gemini-3.1-flash-lite',
  /** Balanced. Best for: most coding tasks and agentic workflows. */
  flash: 'gemini-3.5-flash',
  /** Most capable stable cloud model. Best for: architecture, complex refactors. */
  pro:   'gemini-2.5-pro',

  // ── Claude through Google Vertex AI ─────────────────────────────────────
  /** Fastest enabled Claude preset. Best for: routing and high-volume work. */
  'claude-fast': 'vertex-anthropic:claude-haiku-4-5@20251001',
  /** Recommended Claude preset. Best for: coding and agentic workflows. */
  claude: 'vertex-anthropic:claude-sonnet-5',
  /** Maximum-capability Claude preset. Best for: architecture and hard problems. */
  'claude-max': 'vertex-anthropic:claude-opus-5',

  // ── Versioned Gemini shortcuts (pin to specific generation) ──────────────
  /** Gemini 3.5 Flash — fastest, best for agentic tasks (June 2026 GA). */
  'gemini-3.5-flash':      'gemini-3.5-flash',
  /** Gemini 3.5 Flash Lite — fast, high-volume tasks. */
  'gemini-3.5-lite':       'gemini-3.5-flash-lite',
  /** Gemini 3.1 Flash Lite — cheapest, high-volume tasks. */
  'gemini-3.1-lite':       'gemini-3.1-flash-lite',
  /** Gemini 2.5 Flash Lite — legacy fast/cheap. */
  '2.5-lite':              'gemini-2.5-flash-lite',
  /** Gemini 2.5 Flash — legacy balanced. */
  '2.5-flash':             'gemini-2.5-flash',
  /** Gemini 2.5 Pro — legacy most capable. */
  '2.5-pro':               'gemini-2.5-pro',

  // ── Ollama / Local (free, no API key required) ───────────────────────────
  /** Local inference. Best for: offline development, no API costs. */
  local: 'ollama:llama3.2',
  /** Gemma4 balanced — best local model for general coding tasks. */
  gemma: 'ollama:gemma4',
  /** Gemma4 26B — high quality, needs ~16GB RAM. */
  'gemma-26b': 'ollama:gemma4:26b',
  /** Gemma4 e2b — 2B params, very fast, low RAM. */
  'gemma-2b': 'ollama:gemma4:e2b',
  /** Gemma4 e4b — 4B params, good balance speed/quality. */
  'gemma-4b': 'ollama:gemma4:e4b',
  /** Qwen 3.6B — strong reasoning, fast locally. */
  qwen: 'ollama:qwen3.6',
};


/**
 * Expands a model tier or returns an already concrete model identifier.
 *
 * This function deliberately does not read environment variables. It is used
 * for role profiles so an interactive `AGENT_MODEL` switch does not silently
 * flatten Researcher, Coder, and Verifier onto the same cheap model.
 *
 * @param model - Tier alias or concrete model identifier.
 * @returns A concrete model identifier ready for provider routing.
 */
export function resolveConfiguredModel(model: string): string {
  return MODEL_TIERS[model] ?? model;
}

/**
 * Resolves the Vertex AI region used for Gemini chat requests.
 *
 * Gemini 3.5 is available from the global Vertex AI endpoint. Operators can
 * override this with a supported regional endpoint through GOOGLE_CLOUD_LOCATION.
 *
 * @param configuredLocation - Optional region override, primarily for testing.
 * @returns A Vertex AI endpoint location.
 */
export function resolveVertexLocation(configuredLocation = process.env.GOOGLE_CLOUD_LOCATION): string {
  return configuredLocation?.trim() || 'global';
}

/**
 * Resolves the Google Cloud project used by Vertex-hosted partner models.
 *
 * Gemini's SDK can infer a project from some ADC configurations, but the
 * Anthropic Vertex client requires an explicit project identifier. Keeping the
 * resolver pure makes the requirement deterministic and straightforward to test.
 *
 * @param configuredProject - Optional explicit project, primarily for testing.
 * @returns The trimmed project identifier, or undefined when it is absent.
 */
export function resolveVertexProject(
  configuredProject = process.env.GOOGLE_CLOUD_PROJECT,
): string | undefined {
  return configuredProject?.trim() || undefined;
}

/**
 * Checks the documented Google Cloud project ID shape.
 *
 * Besides improving the prompt error, this validation is a security boundary:
 * Windows launches `gcloud.cmd` through `cmd.exe`, so untrusted shell syntax
 * must never reach that process.
 *
 * @param projectId - Candidate project identifier, not a display name.
 * @returns True for a lowercase 6-30 character Google Cloud project ID.
 */
export function isGoogleCloudProjectId(projectId: string): boolean {
  return /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId);
}

/**
 * Resolve the active LLM model string from the environment and fallback.
 *
 * Checks `AGENT_MODEL` first, then the fallback value, then `DEFAULT_MODEL`.
 * Use `resolveModelForSession()` whenever an explicit user override is present.
 *
 * @param fallback - Optional profile model used when no environment override exists.
 * @returns The resolved model string ready to pass to `createDeepAgent`.
 */
export function resolveModel(fallback?: string): string {
  return resolveConfiguredModel(process.env.AGENT_MODEL ?? fallback ?? DEFAULT_MODEL);
}

/**
 * Resolves the primary model for one CLI or API session.
 *
 * An explicit override is intentionally stronger than `AGENT_MODEL`: a user
 * choosing `--model gemini-2.5-pro` for a single architecture review should
 * not have to edit their cost-efficient global default first.
 *
 * @param profileModel - Model selected by the project role profile.
 * @param explicitModel - Optional per-session CLI or API override.
 * @returns A concrete model identifier.
 */
export function resolveModelForSession(
  profileModel: string,
  explicitModel?: string,
): string {
  return explicitModel === undefined
    ? resolveModel(profileModel)
    : resolveConfiguredModel(explicitModel);
}

/**
 * Returns true when the resolved model is a Gemini (Google) model.
 *
 * Used to determine whether to apply Gemini-specific harness profile fixes
 * (e.g., excluding `grep` and `glob` tools that use Zod union types).
 *
 * Matches:
 * - `"gemini-*"` — bare Gemini model names
 * - `"google:*"` — provider-prefixed Gemini
 * - `"google-genai:*"` — Google GenAI provider format
 * - `"google-vertexai:*"` — Google Vertex AI provider format
 *
 * @param model - The resolved model string.
 * @returns True if the model is a Gemini/Google model.
 */
export function isGeminiModel(model: string): boolean {
  const lower = model.toLowerCase();
  return (
    lower.startsWith('gemini-') ||
    lower.startsWith('google:') ||
    lower.startsWith('google-genai:') ||
    lower.startsWith('google-vertexai:')
  );
}

/**
 * Returns true when the resolved model is an Ollama local model.
 *
 * Used to skip cloud-specific configuration (e.g., no GOOGLE_APPLICATION_CREDENTIALS
 * validation when running local Ollama models).
 *
 * Matches: `"ollama:*"` — Ollama provider format.
 *
 * @param model - The resolved model string.
 * @returns True if the model is an Ollama local model.
 */
export function isOllamaModel(model: string): boolean {
  return model.toLowerCase().startsWith('ollama:');
}

/**
 * Returns true when Claude is transported through Google Vertex AI.
 *
 * The explicit prefix keeps Vertex authentication and billing distinct from a
 * future direct Anthropic API integration using `anthropic:*` identifiers.
 *
 * @param model - The resolved model string.
 * @returns True for `vertex-anthropic:*` model identifiers.
 */
export function isVertexAnthropicModel(model: string): boolean {
  return model.toLowerCase().startsWith('vertex-anthropic:');
}

/**
 * Extracts the provider-native Claude model identifier.
 *
 * @param model - A `vertex-anthropic:*` model identifier.
 * @returns The bare Claude model identifier expected by AnthropicVertex.
 * @throws Error when the identifier is malformed or uses another provider.
 */
export function getVertexAnthropicModelName(model: string): string {
  if (!isVertexAnthropicModel(model)) {
    throw new Error(`Not a Vertex Anthropic model: "${model}".`);
  }

  const modelName = model.slice('vertex-anthropic:'.length).trim();
  if (!modelName.startsWith('claude-')) {
    throw new Error(`Invalid Claude model identifier: "${model}".`);
  }
  return modelName;
}

/**
 * Matches a Claude 5 generation model, optionally carrying a Vertex
 * `@YYYYMMDD` version suffix. Claude 4.5 identifiers such as
 * `claude-haiku-4-5` end in `-4-5` and deliberately do not match.
 */
const CLAUDE_5_GENERATION = /^claude-[a-z]+-5(@\d{8})?$/;

/**
 * Reports whether a Claude model rejects the `temperature` sampling parameter.
 *
 * The Claude 5 generation removed `temperature`; sending it returns HTTP 400
 * `` `temperature` is deprecated for this model `` before any inference runs.
 * Claude 4.5 still accepts it, so the parameter cannot simply be dropped for
 * every Claude model without losing deterministic sampling where it is honored.
 *
 * Verified against the live Vertex endpoint on 2026-08-28: `claude-sonnet-5`
 * and `claude-opus-5` reject it; `claude-haiku-4-5@20251001` accepts it.
 *
 * @param model - A `vertex-anthropic:*` identifier or a bare Claude model name.
 * @returns True when `temperature` must be omitted from the request.
 */
export function rejectsTemperature(model: string): boolean {
  const modelName = isVertexAnthropicModel(model)
    ? getVertexAnthropicModelName(model)
    : model.trim();

  return CLAUDE_5_GENERATION.test(modelName.toLowerCase());
}

/**
 * Returns true when the resolved model is an Anthropic Claude model.
 *
 * Matches: `"anthropic:*"` — Anthropic provider format.
 *
 * @param model - The resolved model string.
 * @returns True if the model is an Anthropic model.
 *
 * @internal
 * @remarks Direct Anthropic API access remains reserved but unsupported. Claude
 *   through Google Vertex AI uses {@link isVertexAnthropicModel} instead.
 */
export function isAnthropicModel(model: string): boolean {
  return model.toLowerCase().startsWith('anthropic:');
}

/**
 * Extract the provider prefix from a model string.
 *
 * Returns the string before the first colon if present.
 * Returns `undefined` for bare model names (no colon).
 *
 * @example
 * extractProvider('anthropic:claude-opus-4-7') // 'anthropic'
 * extractProvider('gemini-2.5-flash-lite')      // undefined
 *
 * @param model - The resolved model string.
 * @returns The provider prefix or undefined.
 */
export function extractProvider(model: string): string | undefined {
  const colonIdx = model.indexOf(':');
  return colonIdx === -1 ? undefined : model.slice(0, colonIdx);
}

/**
 * Default model used for on-demand context compression during `/model` switches.
 *
 * Should be fast and cheap — its only job is to summarize conversation history
 * into a compact handoff message for the incoming model.
 */
export const DEFAULT_SUMMARIZER_MODEL = 'gemini-2.5-flash-lite';

/**
 * Resolves the model to use for context compression during model switches.
 *
 * Priority:
 * 1. `CONTEXT_SUMMARIZER_MODEL` environment variable (operator override)
 * 2. `DEFAULT_SUMMARIZER_MODEL` constant (`'gemini-2.5-flash-lite'`)
 *
 * The summarizer model is intentionally independent from the active `AGENT_MODEL`.
 * This ensures compression always works even when the agent switches to a local
 * Ollama model (which may have no internet access for cloud summarization).
 * If Vertex is unavailable, `ContextCompressor` applies its own Ollama fallback.
 *
 * @returns The model string to use for context compression.
 *
 * @example
 * ```bash
 * # .env — override to use a different summarizer
 * CONTEXT_SUMMARIZER_MODEL=gemini-2.5-pro
 * ```
 */
export function resolveSummarizerModel(): string {
  return process.env.CONTEXT_SUMMARIZER_MODEL ?? DEFAULT_SUMMARIZER_MODEL;
}
