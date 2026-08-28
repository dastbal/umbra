/** Price per million tokens for one model, as published by the provider. */
export interface ModelPricingEntry {
  inputMillion: number;
  outputMillion: number;
}

/**
 * Pricing shipped with the package, in USD per million tokens.
 *
 * This lives in TypeScript rather than JSON on purpose: `tsc` does not copy
 * `.json` files into `dist/`, and `files: ["dist", "README.md"]` does not
 * publish a repository-root JSON either. A JSON-only source meant that every
 * clone and every npm install resolved no prices at all and reported a cost of
 * zero — silently, because a missing price is `undefined`, not an error.
 *
 * A project-local `llm-pricing.json` still overrides these values per model.
 *
 * For Gemini 3.x the published output price is a single combined rate that
 * already includes thinking tokens, so reasoning effort raises the cost of a
 * turn through the output counter rather than through a separate line item.
 *
 * @see LlmPricingConfig
 * @see https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing
 * @see https://ai.google.dev/gemini-api/docs/pricing
 */
export const DEFAULT_LLM_PRICING: Readonly<Record<string, ModelPricingEntry>> = {
  'gemini-3.5-flash': { inputMillion: 1.50, outputMillion: 9.00 },
  'gemini-3.5-flash-lite': { inputMillion: 0.30, outputMillion: 2.50 },
  'gemini-3.1-pro-preview': { inputMillion: 2.00, outputMillion: 12.00 },
  'gemini-3.1-flash-lite': { inputMillion: 0.25, outputMillion: 1.50 },
  'gemini-3.1-flash-lite-preview': { inputMillion: 0.25, outputMillion: 1.50 },
  'gemini-3.0-pro-preview': { inputMillion: 2.00, outputMillion: 12.00 },
  'gemini-3.0-flash-preview': { inputMillion: 0.50, outputMillion: 3.00 },
  'gemini-2.5-pro': { inputMillion: 1.25, outputMillion: 10.00 },
  'gemini-2.5-flash': { inputMillion: 0.30, outputMillion: 2.50 },
  'gemini-2.5-flash-lite': { inputMillion: 0.10, outputMillion: 0.40 },
  'gemini-2.0-flash': { inputMillion: 0.15, outputMillion: 0.60 },
  'gemini-2.0-flash-lite-001': { inputMillion: 0.075, outputMillion: 0.30 },
  'claude-haiku-4-5': { inputMillion: 1.00, outputMillion: 5.00 },
  'claude-sonnet-5': { inputMillion: 2.00, outputMillion: 10.00 },
  'claude-opus-5': { inputMillion: 5.00, outputMillion: 25.00 },
  'text-embedding-004': { inputMillion: 0.025, outputMillion: 0.00 },
};
