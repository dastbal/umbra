/**
 * @module ModelResolver
 *
 * Centralized LLM model resolution for the nestjs-ai-agent-lib.
 *
 * Resolution priority:
 * 1. `AGENT_MODEL` environment variable (highest — runtime switch)
 * 2. `override` parameter passed programmatically
 * 3. `DEFAULT_MODEL` constant (lowest — safe fallback)
 *
 * Supported model string formats:
 * - Bare model name:      "gemini-2.5-flash-lite"   → Google Vertex AI / GenAI
 * - Provider:model:       "anthropic:claude-opus-4-7"
 * - Ollama local:         "ollama:llama3.2"
 * - OpenAI format:        "openai:gpt-4o"
 *
 * @example
 * ```bash
 * # .env.development
 * AGENT_MODEL=gemini-2.5-flash-lite      # fast and cheap (default)
 * AGENT_MODEL=gemini-2.5-pro             # for architecture tasks
 * AGENT_MODEL=ollama:llama3.2            # local, no API costs
 * AGENT_MODEL=anthropic:claude-opus-4-7  # maximum code quality
 * ```
 *
 * @example
 * ```ts
 * const model = resolveModel();                    // reads AGENT_MODEL env
 * const model = resolveModel('gemini-2.5-pro');    // override for orchestrator
 * const model = resolveModel(undefined, 'lite');    // tier-based selection
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
  /** Most capable cloud model. Best for: architecture, complex refactors. */
  pro:   'gemini-3.1-pro',
  /** Maximum quality. Best for: code review, critical logic. */
  claude: 'anthropic:claude-opus-4-7',

  // ── Versioned Gemini shortcuts (pin to specific generation) ──────────────
  /** Gemini 3.5 Flash — fastest, best for agentic tasks (June 2026 GA). */
  'gemini-3.5-flash':      'gemini-3.5-flash',
  /** Gemini 3.1 Flash Lite — cheapest, high-volume tasks. */
  'gemini-3.1-lite':       'gemini-3.1-flash-lite',
  /** Gemini 3.1 Pro — complex reasoning, multimodal. */
  'gemini-3.1-pro':        'gemini-3.1-pro',
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
 * Resolve the active LLM model string.
 *
 * Checks `AGENT_MODEL` env var first, then the programmatic override,
 * then falls back to `DEFAULT_MODEL`.
 *
 * @param override - Optional model string override (takes priority over default,
 *   but NOT over the env variable — the env variable always wins for runtime control).
 * @returns The resolved model string ready to pass to `createDeepAgent`.
 */
export function resolveModel(override?: string): string {
  return process.env.AGENT_MODEL ?? override ?? DEFAULT_MODEL;
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
 * Returns true when the resolved model is an Anthropic Claude model.
 *
 * Matches: `"anthropic:*"` — Anthropic provider format.
 *
 * @param model - The resolved model string.
 * @returns True if the model is an Anthropic model.
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
