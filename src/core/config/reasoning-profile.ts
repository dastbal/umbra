/**
 * @module ReasoningProfile
 *
 * One vocabulary for "how hard should the model think", across every provider
 * Umbra routes to.
 *
 * ## Why this module exists
 *
 * Every current provider exposes a reasoning knob, and no two expose the same
 * one. The split is not Claude-versus-Gemini as it first appears — it is
 * *levels* versus *token budget*, and it cuts across both vendors:
 *
 * | Model family            | Mechanism                  | Shape          |
 * |-------------------------|----------------------------|----------------|
 * | Claude Sonnet 5, Opus 5 | `output_config.effort`     | named levels   |
 * | Claude Haiku 4.5        | `thinking.budget_tokens`   | token count    |
 * | Gemini 3.5, 3.1         | `thinkingLevel`            | named levels   |
 * | Gemini 2.5              | `thinkingBudget`           | token count    |
 * | Ollama                  | none                       | —              |
 *
 * Claude Haiku 4.5 behaves like Gemini 2.5, not like the other Claude models.
 * Any `if (isClaude)` branch would therefore be wrong on its first reading, so
 * the capability is described per model rather than per vendor.
 *
 * This module owns that description and nothing else: it answers *what a model
 * supports*, never *how to send it*. Translating a level into request fields is
 * the provider's job, in Infrastructure.
 *
 * ## Verified, not assumed
 *
 * Every row above was confirmed against the project's live Vertex endpoint on
 * 2026-08-28, including the negative cases: Claude Haiku 4.5 rejects
 * `output_config.effort` with `Extra inputs are not permitted`, and Gemini 2.5
 * rejects `thinkingLevel` with `thinking_level is not supported by this model`.
 * See ADR-016.
 *
 * @example
 * ```ts
 * const profile = describeReasoning('vertex-anthropic:claude-sonnet-5');
 * profile.mechanism;      // 'effort'
 * profile.levels;         // ['low', 'medium', 'high', 'xhigh', 'max']
 * profile.supportsDisplay // true
 * ```
 */

import {
  isOllamaModel,
  isVertexAnthropicModel,
  getVertexAnthropicModelName,
  isClaude5Generation,
} from './model-resolver';

/**
 * How hard the model should think, in Umbra's own vocabulary.
 *
 * This is the union of what every provider offers; no single model supports
 * all six. Always render {@link ReasoningProfile.levels} rather than this type,
 * so the operator is never offered a level their model would reject.
 */
export type ReasoningLevel =
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';

/** Every level, in ascending order of thinking depth. */
export const REASONING_LEVELS: readonly ReasoningLevel[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

/**
 * The provider-side parameter that carries the reasoning level.
 *
 * - `effort` — Claude 5 generation, `output_config.effort`.
 * - `thinking-level` — Gemini 3.x, `thinkingConfig.thinkingLevel`.
 * - `thinking-budget` — Claude 4.5 and Gemini 2.5, a token count.
 * - `none` — the model has no reasoning knob at all.
 */
export type ReasoningMechanism =
  | 'effort'
  | 'thinking-level'
  | 'thinking-budget'
  | 'none';

/**
 * How much control Umbra has over showing the model's reasoning.
 *
 * Three states rather than a boolean, because two of them are indistinguishable
 * to a caller that only asks "can I show it?" while behaving very differently:
 *
 * - `controllable` — Umbra decides. Only the Claude 5 generation, through
 *   `thinking.display`.
 * - `forced-on` — reasoning comes back whenever a level is set, and cannot be
 *   suppressed. Claude 4.5 always returns its thinking text, and
 *   `@langchain/google-common` derives `includeThoughts` from the token budget
 *   rather than accepting it as a parameter (`utils/gemini.js`:896).
 * - `unavailable` — no reasoning is returned at all. Gemini 3.x reached through
 *   `thinkingLevel` gets no `includeThoughts` from the library, so the thoughts
 *   never arrive even though the API itself supports them.
 *
 * The last two are library limitations, not API limitations. They are recorded
 * as they behave rather than as they should behave, because a toggle that
 * silently does nothing is worse than one that says it cannot.
 */
export type ReasoningDisplaySupport = 'controllable' | 'forced-on' | 'unavailable';

/**
 * What one model actually accepts.
 */
export interface ReasoningProfile {
  /** The provider parameter that carries the level, or `none`. */
  mechanism: ReasoningMechanism;
  /**
   * Levels this model accepts, ascending. Empty when `mechanism` is `none`.
   *
   * Render exactly these. A model is never offered a level it would reject,
   * which is what keeps a saved selection from failing after a model switch.
   */
  levels: readonly ReasoningLevel[];
  /**
   * How much say Umbra has over showing the reasoning.
   *
   * Visibility only — thinking happens and is billed under every setting.
   */
  display: ReasoningDisplaySupport;
}

/**
 * Token budgets for the budget-based models, per level.
 *
 * These numbers are Umbra's choice, not a provider mapping — the API takes a
 * raw token count and offers no named levels. They exist so one vocabulary can
 * cover both mechanisms; asking the operator for a token count instead would
 * expose an implementation detail the level abstraction is meant to hide.
 *
 * The floor is 1024 because Anthropic rejects a smaller `budget_tokens`
 * outright. `minimal` is therefore not offered on budget-based models: it
 * cannot be expressed, and Gemini 2.5 Pro additionally refuses to have
 * thinking disabled.
 */
export const REASONING_BUDGET_TOKENS: Readonly<Partial<Record<ReasoningLevel, number>>> = {
  low: 1024,
  medium: 4096,
  high: 16384,
};

/** Levels offered by the Claude 5 generation via `output_config.effort`. */
const EFFORT_LEVELS: readonly ReasoningLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Levels offered by Gemini 3.x via `thinkingLevel`. */
const THINKING_LEVEL_LEVELS: readonly ReasoningLevel[] = ['minimal', 'low', 'medium', 'high'];

/** Levels expressible as a token budget — see {@link REASONING_BUDGET_TOKENS}. */
const BUDGET_LEVELS: readonly ReasoningLevel[] = ['low', 'medium', 'high'];

/** Matches Gemini 3.x, which is where `thinkingLevel` became available. */
const GEMINI_3_GENERATION = /^gemini-3(\.\d+)?-/;

/** Matches Gemini 2.5, which accepts only a token budget. */
const GEMINI_2_5_GENERATION = /^gemini-2\.5-/;

/** A model with no reasoning knob and no reasoning to display. */
const NO_REASONING: ReasoningProfile = {
  mechanism: 'none',
  levels: [],
  display: 'unavailable',
};

/**
 * Describes what reasoning controls a model accepts.
 *
 * Unknown models are reported as having no reasoning knob. That is the safe
 * direction: an unsupported parameter is a hard `400` that kills the turn,
 * whereas omitting it only forgoes the setting.
 *
 * @param model - Any resolved Umbra model string, with or without a prefix.
 * @returns The model's reasoning profile.
 */
export function describeReasoning(model: string): ReasoningProfile {
  const trimmed = model.trim().toLowerCase();

  if (isOllamaModel(trimmed)) return NO_REASONING;

  if (isVertexAnthropicModel(trimmed)) {
    const claudeModel = getVertexAnthropicModelName(trimmed);
    if (isClaude5Generation(claudeModel)) {
      return { mechanism: 'effort', levels: EFFORT_LEVELS, display: 'controllable' };
    }
    // Claude 4.5 keeps the older thinking block: a token budget, and the
    // reasoning text comes back whenever thinking is on — it cannot be
    // suppressed while a level is set.
    return { mechanism: 'thinking-budget', levels: BUDGET_LEVELS, display: 'forced-on' };
  }

  if (GEMINI_3_GENERATION.test(trimmed)) {
    // The library sets `includeThoughts` only alongside a token budget, so a
    // level-based Gemini request returns no thoughts at all.
    return { mechanism: 'thinking-level', levels: THINKING_LEVEL_LEVELS, display: 'unavailable' };
  }

  if (GEMINI_2_5_GENERATION.test(trimmed)) {
    // Conversely, a budget always brings `includeThoughts: true` with it.
    return { mechanism: 'thinking-budget', levels: BUDGET_LEVELS, display: 'forced-on' };
  }

  return NO_REASONING;
}

/**
 * Narrows an untrusted string to a {@link ReasoningLevel}.
 *
 * @param value - Candidate level, typically from `.env` or a CLI argument.
 * @returns True when the value is one of Umbra's levels.
 */
export function isReasoningLevel(value: string): value is ReasoningLevel {
  return (REASONING_LEVELS as readonly string[]).includes(value);
}

/**
 * Resolves the reasoning level a model will actually run at.
 *
 * A level persisted for one model may not exist on the next one selected —
 * `xhigh` is real on Claude Opus 5 and meaningless on Gemini 3.5. Rather than
 * send it and collect a `400`, the level is clamped to the nearest one the
 * model does support, walking down first and then up.
 *
 * @param model - The model the request will be sent to.
 * @param requested - The configured level, or undefined for the model default.
 * @returns The level to send, or undefined to omit the parameter entirely.
 */
export function resolveReasoningLevel(
  model: string,
  requested: ReasoningLevel | undefined,
): ReasoningLevel | undefined {
  if (!requested) return undefined;

  const { levels } = describeReasoning(model);
  if (levels.length === 0) return undefined;
  if (levels.includes(requested)) return requested;

  const requestedRank = REASONING_LEVELS.indexOf(requested);
  const supportedRanks = levels
    .map((level) => REASONING_LEVELS.indexOf(level))
    .sort((a, b) => a - b);

  // Prefer the closest supported level at or below the request, so clamping
  // never silently escalates cost. Fall back upward only when the request is
  // below everything the model offers.
  const below = supportedRanks.filter((rank) => rank <= requestedRank).pop();
  const chosen = below ?? supportedRanks[0];
  return REASONING_LEVELS[chosen];
}

/**
 * Converts a level into the token budget used by the budget-based models.
 *
 * @param level - A level supported by a `thinking-budget` model.
 * @returns The token budget, or undefined when the level has no budget.
 */
export function reasoningBudgetTokens(level: ReasoningLevel): number | undefined {
  return REASONING_BUDGET_TOKENS[level];
}

/** Environment variable holding the configured reasoning level. */
export const REASONING_LEVEL_ENV = 'AGENT_REASONING';

/** Environment variable holding the reasoning-display preference. */
export const REASONING_DISPLAY_ENV = 'AGENT_REASONING_DISPLAY';

/**
 * Reads the configured reasoning level from the environment.
 *
 * An unrecognized value is treated as unset rather than as an error: a typo in
 * `.env` should leave the provider default in place, not refuse to start a
 * session.
 *
 * @param override - Explicit value, used instead of the environment when given.
 * @returns The configured level, or undefined when unset or unrecognized.
 */
export function resolveConfiguredReasoningLevel(
  override?: string,
): ReasoningLevel | undefined {
  const raw = (override ?? process.env[REASONING_LEVEL_ENV] ?? '').trim().toLowerCase();
  return isReasoningLevel(raw) ? raw : undefined;
}

/**
 * Reads whether the operator asked to see the model's reasoning.
 *
 * Defaults to false. Reasoning is billed either way, so this only decides
 * whether the tokens already paid for are shown.
 *
 * @param override - Explicit value, used instead of the environment when given.
 * @returns True when reasoning should be requested for display.
 */
export function resolveConfiguredReasoningDisplay(override?: string): boolean {
  const raw = (override ?? process.env[REASONING_DISPLAY_ENV] ?? '').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'on';
}
