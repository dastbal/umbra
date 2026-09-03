import { loadAgentConfig } from '../../config/agent-config';
import { runtimeRoot } from '../../config/runtime-root';
import { EmbeddingsPort, EmbeddingsProvider } from './embeddings.port';
import { OllamaEmbeddingsAdapter } from './ollama-embeddings.adapter';
import { VertexEmbeddingsAdapter } from './vertex-embeddings.adapter';

/**
 * Chooses which embedding provider answers a query, and reports why.
 *
 * ## Precedence
 *
 * Explicit argument → `UMBRA_EMBEDDINGS` → `.umbra/agent.config.json` →
 * `vertex`.
 *
 * This is the same ladder ADR-002 fixed for model resolution, reused rather
 * than reinvented. The important end of it is the last rung: **the default is
 * still Vertex**, so an installation that changes nothing behaves exactly as it
 * did before ADR-025.
 *
 * An unrecognised value is reported and ignored rather than silently defaulted,
 * because a typo in a config file that quietly changes which vector space is
 * used is precisely the class of failure ADR-017 was written about.
 *
 * @example
 * ```ts
 * const { port, source } = resolveEmbeddings();      // honours env and config
 * const forced = resolveEmbeddings('ollama').port;   // explicit wins
 * ```
 */

/** Environment variable that selects the embedding provider. */
export const EMBEDDINGS_ENV_VAR = 'UMBRA_EMBEDDINGS';

/** Where the selection came from, for diagnostics. */
export type EmbeddingsSelectionSource =
  | 'argument'
  | 'pinned'
  | 'environment'
  | 'config'
  | 'default';

/**
 * Provider pinned for the lifetime of the process, if any.
 *
 * ## Why a pin is required, and an argument is not enough
 *
 * `askCodebaseTool` constructs its retriever as `new RetrieverService()`, with
 * no argument — it is a LangChain tool body with no access to whatever the CLI
 * parsed. So `umbra mcp --embeddings ollama` reached the availability probe and
 * the indexer, and **never reached the query**: retrieval silently resolved to
 * the config default and answered from the Vertex column, while the provenance
 * header printed the provider that had been selected at launch.
 *
 * That is worse than either half alone. A wrong answer is a bug; a wrong answer
 * carrying a confident, incorrect statement of where it came from is the exact
 * failure this subsystem was built to make impossible.
 *
 * Caught by a live cross-provider run, not by the unit tests — which passed,
 * because they inject the port directly and therefore never exercise the path
 * a launch flag actually takes.
 *
 * Same problem and same shape as the pinned runtime root: a launch-time
 * decision has to reach code that takes no parameters.
 */
let pinnedProvider: EmbeddingsProvider | undefined;

/**
 * Fixes the embedding provider for the lifetime of the process.
 *
 * Ranks below an explicit call-site argument and above the environment, so a
 * test or an embedded consumer can still override per call.
 *
 * @param provider - Provider selected at launch, or `undefined` to leave the
 *        ladder alone.
 * @returns Nothing.
 */
export function pinEmbeddingsProvider(provider: EmbeddingsProvider | undefined): void {
  pinnedProvider = provider;
}

/**
 * Clears the pinned provider.
 *
 * Exists for tests, which must not leak a provider into the next spec.
 */
export function resetPinnedEmbeddingsProvider(): void {
  pinnedProvider = undefined;
}

/** A resolved provider plus the provenance of the decision. */
export interface EmbeddingsSelection {
  /** The port to embed with. */
  readonly port: EmbeddingsPort;
  /** Which rung of the ladder decided. */
  readonly source: EmbeddingsSelectionSource;
  /** Set when a value was present but not a known provider. */
  readonly ignoredValue?: string;
}

/**
 * Narrows an arbitrary string to a known provider.
 *
 * @param value - Candidate provider name.
 * @returns The provider, or `undefined` when unrecognised.
 */
function asProvider(value: string | undefined): EmbeddingsProvider | undefined {
  if (value === 'vertex' || value === 'ollama') return value;
  return undefined;
}

/**
 * Builds the adapter for a provider.
 *
 * @param provider - The selected provider.
 * @param model - Optional model override from configuration.
 * @returns A ready port.
 */
function instantiate(provider: EmbeddingsProvider, model?: string): EmbeddingsPort {
  if (provider === 'ollama') {
    return model ? new OllamaEmbeddingsAdapter(model) : new OllamaEmbeddingsAdapter();
  }
  return new VertexEmbeddingsAdapter();
}

/**
 * Resolves the active embedding provider.
 *
 * Configuration is read from the pinned runtime root, so `umbra mcp --root X`
 * honours `X`'s policy rather than the client's working directory. A malformed
 * or absent config file is not fatal here: `loadAgentConfig` already returns
 * defaults, and embeddings must not be the reason a read-only server refuses to
 * start.
 *
 * @param explicit - A provider chosen at the call site, e.g. a CLI flag.
 * @returns The selected port and the provenance of the selection.
 */
export function resolveEmbeddings(explicit?: string): EmbeddingsSelection {
  const fromArgument = asProvider(explicit);
  if (fromArgument) {
    return { port: instantiate(fromArgument, configuredModel(fromArgument)), source: 'argument' };
  }

  if (pinnedProvider !== undefined) {
    return {
      port: instantiate(pinnedProvider, configuredModel(pinnedProvider)),
      source: 'pinned',
      ignoredValue: invalidValue(explicit, undefined),
    };
  }

  const envValue = process.env[EMBEDDINGS_ENV_VAR]?.trim();
  const fromEnv = asProvider(envValue);
  if (fromEnv) {
    return { port: instantiate(fromEnv, configuredModel(fromEnv)), source: 'environment' };
  }

  const configured = readConfiguredProvider();
  if (configured) {
    return {
      port: instantiate(configured, configuredModel(configured)),
      source: 'config',
      ignoredValue: invalidValue(explicit, envValue),
    };
  }

  return {
    port: new VertexEmbeddingsAdapter(),
    source: 'default',
    ignoredValue: invalidValue(explicit, envValue),
  };
}

/**
 * Reports a value that was supplied but not understood, so the caller can warn.
 *
 * @param explicit - The explicit argument, if any.
 * @param envValue - The environment value, if any.
 * @returns The offending value, or `undefined` when both were absent or valid.
 */
function invalidValue(explicit?: string, envValue?: string): string | undefined {
  if (explicit && !asProvider(explicit)) return explicit;
  if (envValue && !asProvider(envValue)) return envValue;
  return undefined;
}

/**
 * Reads the provider from the project policy file.
 *
 * @returns The configured provider, or `undefined` when unset or unreadable.
 */
function readConfiguredProvider(): EmbeddingsProvider | undefined {
  try {
    return asProvider(loadAgentConfig(runtimeRoot()).rag.embeddings);
  } catch {
    // A policy file this process cannot parse is a problem for the commands
    // that depend on it; it is not a reason to refuse to embed. The default
    // provider is correct and the config loader reports its own errors.
    return undefined;
  }
}

/**
 * Reads the optional model override for a provider from the project policy.
 *
 * @param provider - The provider whose model is being resolved.
 * @returns The configured model name, or `undefined` to use the adapter default.
 */
function configuredModel(provider: EmbeddingsProvider): string | undefined {
  try {
    const config = loadAgentConfig(runtimeRoot());
    if (asProvider(config.rag.embeddings) !== provider) return undefined;
    return config.rag.embeddingsModel;
  } catch {
    return undefined;
  }
}
