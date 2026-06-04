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
 */
export const MODEL_TIERS: Record<string, string> = {
  /** Quick tasks, cheap. Best for: simple file edits, Q&A. */
  lite: 'gemini-2.5-flash-lite',
  /** Balanced. Best for: most coding tasks. */
  flash: 'gemini-2.5-flash',
  /** Most capable. Best for: architecture, complex refactors. */
  pro: 'gemini-2.5-pro',
  /** Maximum quality. Best for: code review, critical logic. */
  claude: 'anthropic:claude-opus-4-7',
  /** Local inference. Best for: offline development, no API costs. */
  local: 'ollama:llama3.2',
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
