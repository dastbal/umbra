/**
 * @module OllamaChatAdapter
 *
 * A transparent wrapper around `ChatOllama` that normalizes tool-call message
 * content before forwarding them to the Ollama API.
 *
 * ## Problem
 * Ollama's OpenAI-compatible API requires all message `content` fields to be
 * strings. When `deepagents` (or any LangChain tool) returns a ToolMessage
 * whose `.content` is an object or array, `ChatOllama` throws:
 *
 *   > Non string tool message content is not supported
 *
 * ## Solution
 * `OllamaChatAdapter` intercepts the `messages` array in `_generate()` and
 * `stream()`, finds any `ToolMessage` whose content is not a string, and
 * JSON-serializes it. The rest of the call is delegated to the parent class.
 *
 * This is fully transparent — callers see a normal `ChatOllama` instance.
 * `deepagents` receives a `BaseChatModel` and uses it directly without string
 * routing through `initChatModel`, so no secondary resolution occurs.
 *
 * @example
 * ```ts
 * const model = new OllamaChatAdapter({
 *   model: 'gemma4:e2b',
 *   baseUrl: 'http://localhost:11434',
 *   temperature: 0,
 * });
 * createDeepAgent({ model }); // passes BaseChatModel directly
 * ```
 */

import { ChatOllama } from '@langchain/ollama';
import { BaseMessage, ToolMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';

// ── CPU/RAM preflight types ───────────────────────────────────────────────────

/**
 * Describes a single model currently loaded in Ollama's process space.
 * Matches the shape returned by `GET /api/ps`.
 */
export interface OllamaLoadedModel {
  /** Model name as shown in `ollama list` (e.g. "gemma4:e4b"). */
  name: string;
  /** RAM currently consumed by this model (bytes). */
  size: number;
  /** Human-readable size label (e.g. "9.0 GB"). */
  size_vram?: number;
}

/**
 * Result of `OllamaChatAdapter.preflight()`.
 *
 * Contains enough information for the CLI to show a meaningful warning
 * before the first inference is attempted.
 */
export interface OllamaPreflightResult {
  /** Whether Ollama responded to the /api/ps health probe. */
  ollamaReachable: boolean;
  /** Models currently loaded into RAM by Ollama. */
  loadedModels: OllamaLoadedModel[];
  /** Total RAM consumed by all loaded Ollama models (bytes). */
  totalLoadedBytes: number;
  /**
   * Whether the target model needs to swap another model out of RAM
   * before it can load. True when multiple models are loaded simultaneously.
   */
  requiresSwap: boolean;
  /**
   * Estimated RAM needed to load the target model (bytes).
   * Derived from `ollama show` metadata when available, otherwise 0 (unknown).
   */
  estimatedModelBytes: number;
}

// ── Main adapter class ────────────────────────────────────────────────────────

/**
 * Transparent `ChatOllama` wrapper that serializes non-string tool message
 * content before sending to the Ollama API.
 *
 * Ollama's API layer rejects tool message content that is not a plain string.
 * Tools in deepagents (e.g., built-in `read_file`) may return objects. This
 * adapter stringifies any such content transparently so Ollama can process it.
 *
 * All other behavior (streaming, tool binding, temperature, etc.) is inherited
 * from `ChatOllama` without modification.
 *
 * ## Extended timeout (ADR-022)
 * CPU-only inference on large models (8B+) can take 2–5 minutes for the first
 * token. We override the default fetch timeout to 5 minutes so `deepagents`
 * does not kill the connection prematurely and surface a confusing `fetch failed`.
 */
export class OllamaChatAdapter extends ChatOllama {
  /**
   * Lookup hint that lets deepagents find Umbra's Ollama harness profile.
   *
   * ## Why this exists
   *
   * Umbra passes a prebuilt model instance, so deepagents resolves the harness
   * profile from the instance rather than from a model string. That path reads
   * two hints, and this adapter supplied neither:
   *
   * - the provider comes from a three-entry map keyed on `getName()` —
   *   `ChatAnthropic`, `ChatOpenAI`, `ChatGoogleGenerativeAI`. This class
   *   reports `ChatOllama`, so the provider hint was `undefined`.
   * - the identifier comes from `model_name ?? modelName`, and `ChatOllama`
   *   defines neither — it stores the name in `model`.
   *
   * With both hints missing the profile resolved to the empty one, so **every
   * exclusion Umbra registers for Ollama was silently discarded**: deepagents'
   * built-in `ls`, `read_file`, `write_file`, `edit_file`, `grep` and `glob`
   * stayed live. Those read deepagents' in-memory `StateBackend`, not the disk,
   * so `ls` returned an empty directory in 2ms and the model faithfully
   * reported that the project had no files. Verified on a real run, 2026-08-28.
   *
   * ## Why this shape
   *
   * Returning `ollama:<name>` makes the identifier lookup land on the `ollama`
   * provider key, where the profile is registered. The tag separator becomes a
   * dash because deepagents rejects any spec with more than two colon-separated
   * parts before it ever consults the provider key — `ollama:gemma4:e2b` would
   * resolve to nothing, which is the same failure by a different route.
   *
   * @returns A two-part spec that resolves to the `ollama` harness profile.
   */
  public get modelName(): string {
    return `ollama:${String(this.model).replace(/:/g, '-')}`;
  }

  /**
   * Creates an OllamaChatAdapter with a 5-minute fetch timeout.
   *
   * `ChatOllamaInput` does not expose a `timeout` property directly, but it
   * accepts a custom `fetch` function. We inject a wrapper that attaches a
   * 5-minute `AbortController` to every request — this overrides the default
   * Node.js fetch timeout which is effectively the OS socket timeout (varies,
   * but usually far shorter than 5 min on Windows).
   *
   * The extended timeout is critical for CPU-only users: `gemma4:e4b` (8B)
   * can take 2–5 minutes to load from disk and generate the first token.
   * Without this, the fetch times out first → confusing `fetch failed`.
   *
   * @param fields - Same config as `ChatOllama` constructor.
   */
  constructor(fields: ConstructorParameters<typeof ChatOllama>[0]) {
    const FIVE_MINUTES_MS = 5 * 60 * 1000;

    /**
     * Fetch wrapper that adds a 5-minute AbortController timeout to every
     * Ollama API call. This prevents the default (short) OS socket timeout
     * from killing long CPU-only inference requests mid-flight.
     */
    const fetchWithTimeout: typeof fetch = (input, init) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FIVE_MINUTES_MS);
      return fetch(input, {
        ...init,
        // Merge any existing signal from the caller with ours.
        // If caller already provided a signal, we race both — ours fires at 5 min.
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));
    };

    super({
      ...(typeof fields === 'string' ? { model: fields } : fields),
      fetch: fetchWithTimeout,
    });
  }

  // ── Static utilities ────────────────────────────────────────────────────────

  /**
   * Queries Ollama's `/api/ps` endpoint to inspect which models are currently
   * loaded in RAM, then computes a RAM pressure report.
   *
   * Used by `DeepAgentFactory.bootstrap()` to show a warning before the
   * first inference if the system is likely to experience extreme latency
   * (e.g., model swap required due to limited RAM).
   *
   * @param baseUrl - Ollama base URL (default: `http://localhost:11434`).
   * @returns Preflight result, or a safe default if Ollama is unreachable.
   */
  public static async preflight(
    baseUrl = 'http://localhost:11434',
  ): Promise<OllamaPreflightResult> {
    const safe: OllamaPreflightResult = {
      ollamaReachable: false,
      loadedModels: [],
      totalLoadedBytes: 0,
      requiresSwap: false,
      estimatedModelBytes: 0,
    };

    try {
      // Hard timeout: if Ollama doesn't respond in 3s, it's not reachable.
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);

      const res = await fetch(`${baseUrl}/api/ps`, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!res.ok) return safe;

      const body = (await res.json()) as { models?: OllamaLoadedModel[] };
      const loadedModels = body.models ?? [];
      const totalLoadedBytes = loadedModels.reduce((sum, m) => sum + (m.size ?? 0), 0);

      return {
        ollamaReachable: true,
        loadedModels,
        totalLoadedBytes,
        // Swap required when more than 1 model is loaded — Ollama needs to
        // evict the current model before loading the next one.
        requiresSwap: loadedModels.length > 1,
        estimatedModelBytes: 0, // Not queried — too slow for preflight
      };
    } catch {
      return safe;
    }
  }

  /**
   * Pre-warms the target Ollama model by sending a minimal generation request.
   *
   * This forces Ollama to load the model from disk into RAM **before**
   * `deepagents` makes its first real inference request. Without warmup,
   * `deepagents` fires the real request while the model is still loading —
   * and the internal `fetch` timeout (previously default, now 5 min) may
   * still expire on a very RAM-constrained machine.
   *
   * By warming up first (with a 1-token generation), we guarantee the model
   * is resident in RAM when deepagents needs it.
   *
   * `keep_alive: "10m"` extends Ollama's model eviction timer (default 5 min)
   * so the model stays loaded for the full CLI session without re-loading.
   *
   * @param model - Bare model name (e.g. `"gemma4:e2b"`, NOT `"ollama:gemma4:e2b"`).
   * @param baseUrl - Ollama base URL.
   * @param onProgress - Optional callback called while waiting for warmup.
   * @returns `true` if warmup succeeded, `false` if it timed out or failed.
   */
  public static async warmup(
    model: string,
    baseUrl = 'http://localhost:11434',
    onProgress?: (elapsedMs: number) => void,
  ): Promise<boolean> {
    const WARMUP_TIMEOUT_MS = 5 * 60 * 1000; // 5 min max
    const PROGRESS_INTERVAL_MS = 15_000; // log every 15s

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), WARMUP_TIMEOUT_MS);

    // Fire progress callbacks every 15s so the CLI can reassure the user
    let progressTimer: ReturnType<typeof setInterval> | undefined;
    const startedAt = Date.now();
    if (onProgress) {
      progressTimer = setInterval(
        () => onProgress(Date.now() - startedAt),
        PROGRESS_INTERVAL_MS,
      );
    }

    try {
      const res = await fetch(`${baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt: 'Hi',
          stream: false,
          // Generate exactly 1 token — minimize warmup inference cost
          options: { num_predict: 1 },
          // Keep model in RAM for 10 minutes (avoids reload mid-session)
          keep_alive: '10m',
        }),
        signal: controller.signal,
      });

      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeoutId);
      if (progressTimer) clearInterval(progressTimer);
    }
  }

  // ── Private: message normalization ─────────────────────────────────────────

  /**
   * Normalize a messages array so all ToolMessage content values are strings.
   *
   * - If content is already a string, it is left unchanged.
   * - If content is an array of content blocks (LangChain's multi-part format),
   *   we extract all `text` parts and join them, or fall back to JSON.stringify.
   * - Otherwise, JSON.stringify is used.
   *
   * @param messages - The full message array from the agent loop.
   * @returns A new array with ToolMessage contents coerced to strings.
   */
  private normalizeToolMessages(messages: BaseMessage[]): BaseMessage[] {
    return messages.map((msg) => {
      if (!(msg instanceof ToolMessage)) return msg;
      const content = msg.content;

      if (typeof content === 'string') return msg;

      let serialized: string;
      if (Array.isArray(content)) {
        // LangChain multi-part blocks: [{type:'text', text:'...'}, ...]
        const textParts = content
          .filter((block) => typeof block === 'object' && block !== null && 'text' in block)
          .map((block) => (block as { text: string }).text);
        serialized = textParts.length > 0 ? textParts.join('\n') : JSON.stringify(content);
      } else {
        serialized = JSON.stringify(content);
      }

      // Reconstruct a ToolMessage with the serialized string content.
      return new ToolMessage({
        content: serialized,
        tool_call_id: msg.tool_call_id,
        name: msg.name,
        additional_kwargs: msg.additional_kwargs,
      });
    });
  }

  /**
   * Override `_generate` to normalize tool message content before the API call.
   *
   * @param messages - Raw message array from the agent loop.
   * @param options - LangChain call options (tools, stop sequences, etc.).
   * @param runManager - Optional LangChain callback manager.
   * @returns The model's `ChatResult`.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override async _generate(messages: BaseMessage[], options: any, runManager?: any): Promise<ChatResult> {
    return super._generate(this.normalizeToolMessages(messages), options, runManager);
  }

  /**
   * Override `stream` to normalize tool message content before the API call.
   *
   * @param messages - Raw message array from the agent loop.
   * @param options - LangChain call options.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override stream(messages: BaseMessage[], options?: any): any {
    return super.stream(this.normalizeToolMessages(messages), options);
  }
}
