import { LLMProvider } from '../../llm/provider';
import { OllamaChatAdapter } from '../../llm/ollama-adapter';
import { EmbeddingsPort } from './embeddings.port';
import { resolveOllamaBaseUrl } from './ollama-embeddings.adapter';

/**
 * Answers one question before a tool is advertised: *can this actually respond?*
 *
 * ## Why a probe rather than a try/catch at call time
 *
 * ADR-013 recorded what it costs to tell a model about a tool it cannot use —
 * the run dies mid-task, and the model is blamed for a failure that was
 * declared into existence. `umbra mcp` publishes a fixed tool list at launch,
 * so the decision has to be made once, up front, with evidence.
 *
 * That is why this checks the *model*, not just the service. Ollama answering
 * on its port proves nothing if `nomic-embed-text` was never pulled: the tool
 * would be advertised and then fail on first use, which is the exact defect
 * ADR-013 is about.
 *
 * @example
 * ```ts
 * const { available, reason } = await probeEmbeddings(port);
 * if (!available) log(`ask_codebase not published: ${reason}`);
 * ```
 */

/** Outcome of an availability probe. */
export interface EmbeddingsAvailability {
  /** Whether embedding calls can be expected to succeed. */
  readonly available: boolean;
  /** Present when unavailable: a diagnosable explanation, safe to print. */
  readonly reason?: string;
}

/**
 * Checks whether the given port can serve an embedding call.
 *
 * Never throws: an unavailable provider is a fact to report, not an error to
 * propagate. A read-only server must still start and still publish the three
 * tools that need no credentials.
 *
 * @param port - The resolved embedding port.
 * @returns Availability, with a reason when unavailable.
 */
export async function probeEmbeddings(
  port: EmbeddingsPort,
): Promise<EmbeddingsAvailability> {
  if (port.identity.provider === 'ollama') {
    return probeOllama(port.identity.model);
  }
  return probeVertex();
}

/**
 * Verifies that Ollama is reachable and the embedding model is installed.
 *
 * Reachability reuses `OllamaChatAdapter.preflight`, which already carries a
 * 3-second hard timeout and returns a safe default instead of throwing.
 *
 * @param model - The embedding model that must be present.
 * @returns Availability, with a reason when unavailable.
 */
async function probeOllama(model: string): Promise<EmbeddingsAvailability> {
  const baseUrl = resolveOllamaBaseUrl();

  const preflight = await OllamaChatAdapter.preflight(baseUrl);
  if (!preflight.ollamaReachable) {
    return {
      available: false,
      reason: `Ollama is not reachable at ${baseUrl}. Start it, or set OLLAMA_BASE_URL.`,
    };
  }

  const installed = await listOllamaModels(baseUrl);
  if (installed === undefined) {
    // Reachable but the tag listing failed. Reporting unavailable would be
    // wrong — the service answered — so this trusts reachability and lets the
    // first call surface any real problem.
    return { available: true };
  }

  // Ollama reports tags as `name:tag`; a bare model name matches its `:latest`.
  const present = installed.some(
    (candidate) => candidate === model || candidate.split(':')[0] === model,
  );

  if (!present) {
    return {
      available: false,
      reason: `Ollama is running but the model "${model}" is not installed. Run: ollama pull ${model}`,
    };
  }

  return { available: true };
}

/**
 * Lists the models installed in a local Ollama.
 *
 * @param baseUrl - Ollama endpoint.
 * @returns Model names, or `undefined` when the listing could not be read.
 */
async function listOllamaModels(baseUrl: string): Promise<string[] | undefined> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    const response = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) return undefined;

    const body = (await response.json()) as { models?: { name?: string }[] };
    return (body.models ?? [])
      .map((entry) => entry.name)
      .filter((name): name is string => typeof name === 'string');
  } catch {
    return undefined;
  }
}

/**
 * Verifies that Application Default Credentials are present for Vertex.
 *
 * Probes by constructing the embedding client, which runs
 * `ensureVertexCredentials` and resolves the project internally. That is
 * deliberate: it fails in exactly the way a real query would, which is the only
 * kind of probe worth trusting. `ensureVertexCredentials` itself is private and
 * stays that way — widening the provider's surface for a diagnostic would be
 * the wrong trade.
 *
 * Construction is cheap and cached, so a successful probe also warms the client
 * the first query will use. No network call is made here.
 *
 * @returns Availability, with a reason when unavailable.
 */
function probeVertex(): EmbeddingsAvailability {
  try {
    LLMProvider.getEmbeddingsModel();
    return { available: true };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      available: false,
      reason: `Vertex embeddings need Google credentials: ${message} Run: umbra auth login`,
    };
  }
}
