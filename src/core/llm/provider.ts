/**
 * @module LLMProvider
 *
 * Multi-provider LLM factory for nestjs-ai-agent-lib.
 *
 * ## Provider Routing
 * The provider is inferred from the model string:
 * - `"gemini-*"`, `"google:*"`, `"google-vertexai:*"` → Vertex AI (`ChatVertexAI`)
 * - `"vertex-anthropic:*"` → Claude on Vertex AI (`ChatAnthropic` + `AnthropicVertex`)
 * - `"ollama:*"` → Local Ollama (`OllamaChatAdapter` — a `ChatOllama` wrapper
 *   that serializes non-string tool message content before sending to Ollama API)
 *
 * ## Embeddings
 * Embeddings are **always** Vertex AI (`VertexAIEmbeddings` with `text-embedding-004`),
 * regardless of which chat model is active. Rationale: Ollama embedding models are
 * significantly lower quality than Google's, and the RAG index would need a full
 * re-index every time you switch models. Using a stable cloud embedding model
 * keeps the index consistent and fast.
 *
 * @example
 * ```ts
 * // Auto-routes based on AGENT_MODEL env var
 * const chat = LLMProvider.createChatModel('gemini-3.5-flash');        // latest
 * const chat = LLMProvider.createChatModel('gemini-3.1-flash-lite');   // cheap
 * const chat = LLMProvider.createChatModel('gemini-2.5-pro');          // powerful
 * const chat = LLMProvider.createChatModel('gemini-2.5-flash-lite');   // legacy
 * const chat = LLMProvider.createChatModel('ollama:gemma4');           // local
 *
 * // Embeddings are always Vertex AI
 * const embeddings = LLMProvider.getEmbeddingsModel();
 * ```
 */

import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';
import { ChatAnthropic } from '@langchain/anthropic';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatVertexAI, VertexAIEmbeddings } from '@langchain/google-vertexai';
import { OllamaChatAdapter } from './ollama-adapter';
import { VertexChatAdapter } from './vertex-chat-adapter';
import {
  isOllamaModel,
  isGeminiModel,
  isVertexAnthropicModel,
  getVertexAnthropicModelName,
  rejectsTemperature,
  resolveVertexLocation,
  resolveVertexProject,
} from '../config/model-resolver';
import {
  ReasoningLevel,
  describeReasoning,
  reasoningBudgetTokens,
  resolveConfiguredReasoningDisplay,
  resolveConfiguredReasoningLevel,
  resolveReasoningLevel,
} from '../config/reasoning-profile';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// Load env vars from the project root on module import.
// process.cwd() resolves to the target workspace where `umbra` is executed.
//
// `quiet: true` is not cosmetic. dotenv v17 prints "injected env (n) from .env"
// plus a usage tip to **stdout** on every call, and under `umbra mcp` stdout
// carries JSON-RPC: two library banner lines corrupted the connection before
// the first response. `src/bin/cli.ts` already passed `quiet` on its own two
// calls; these two, running at module import, did not. Verified by the stdout
// purity check (ADR-024, constraint 4).
const rootDir = process.cwd();
dotenv.config({ path: path.join(rootDir, '.env'), quiet: true });
dotenv.config({ path: path.join(rootDir, '.env.development'), quiet: true });

/**
 * Effort levels Anthropic accepts in `output_config.effort`.
 *
 * Declared here rather than imported because `@langchain/anthropic`'s own
 * `OutputConfig` type omits `xhigh`, which the underlying Anthropic SDK and the
 * live Vertex endpoint both accept — verified returning HTTP 200 on
 * `claude-sonnet-5` on 2026-08-28. Narrowing Umbra to LangChain's stale type
 * would drop a working level; this keeps it while staying explicit about why.
 */
type AnthropicEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Multi-provider LLM factory.
 *
 * Provides `createChatModel()` which routes to the correct provider
 * (Vertex AI or Ollama) based on the model string format.
 *
 * Embeddings are always Vertex AI — see module JSDoc for rationale.
 */
export class LLMProvider {
  /** Singleton Vertex AI embeddings instance (reused across calls). */
  private static embeddingsInstance: VertexAIEmbeddings | undefined;

  private constructor() {}

  // ── Chat Model Factory ────────────────────────────────────────────────────

  /**
   * Creates the appropriate chat model for the given model string.
   *
   * Routes to:
   * - `ChatVertexAI` for Gemini/Google models (`gemini-*`, `google:*`, `google-vertexai:*`)
   * - `ChatAnthropic` for Claude on Vertex AI (`vertex-anthropic:*`)
   * - `ChatOllama` for local Ollama models (`ollama:*`)
   *
   * Both implement `BaseChatModel` from `@langchain/core`, so they are
   * drop-in compatible with `createDeepAgent` and all LangChain tools.
   *
   * @param model - The full model string (e.g., "gemini-2.5-flash", "ollama:gemma4").
   * @param temperature - Sampling temperature. Default: 0 (deterministic, good for coding).
   * @returns A configured `BaseChatModel` ready for use.
   * @throws {Error} If using a Vertex AI model without valid credentials.
   */
  public static createChatModel(
    model: string,
    temperature = 0,
  ): BaseChatModel {
    if (isOllamaModel(model)) {
      return LLMProvider.createOllamaModel(model, temperature);
    }

    if (isVertexAnthropicModel(model)) {
      return LLMProvider.createVertexAnthropicModel(model, temperature);
    }

    if (isGeminiModel(model) || !model.includes(':')) {
      // Bare model names (no provider prefix) default to Vertex AI
      return LLMProvider.createVertexModel(model, temperature);
    }

    // Unrecognized provider prefix — throw a helpful error
    const provider = model.split(':')[0];
    throw new Error(
      `Unsupported LLM provider: "${provider}". ` +
      `Supported providers: "ollama", "gemini-*", "vertex-anthropic". ` +
      `Set AGENT_MODEL in your .env file.`,
    );
  }

  // ── Embeddings (always Vertex AI) ─────────────────────────────────────────

  /**
   * Returns the singleton Vertex AI embeddings model.
   *
   * Embeddings are ALWAYS Vertex AI, regardless of the active chat model.
   * See module JSDoc for the architectural rationale.
   *
   * @returns The configured `VertexAIEmbeddings` instance.
   * @throws {Error} If `GOOGLE_APPLICATION_CREDENTIALS` is not set or invalid.
   */
  public static getEmbeddingsModel(): VertexAIEmbeddings {
    if (!LLMProvider.embeddingsInstance) {
      LLMProvider.ensureVertexCredentials();
      LLMProvider.embeddingsInstance = new VertexAIEmbeddings({
        model: 'text-embedding-004',
        // Passed explicitly rather than left to Google's auto-detection. ADC
        // user credentials carry no project id, so the library falls back to
        // reading gcloud's own config — which is absent or unreadable on a
        // machine where the gcloud CLI is broken. Every chunk then failed with
        // "Unable to detect a Project Id", once per chunk.
        ...LLMProvider.vertexProjectField(),
      });
    }
    return LLMProvider.embeddingsInstance;
  }

  /**
   * Supplies the Google Cloud project to a Vertex client, when configured.
   *
   * Claude's route required the project from the start and failed loudly
   * without it. Gemini and embeddings instead relied on Google's auto-detection
   * and produced a raw library error in any project whose `.env` omits
   * `GOOGLE_CLOUD_PROJECT` — the common case for a consumer of the package.
   *
   * The field is omitted when unset so auto-detection still works where it
   * does work (a service account file carries its own project).
   *
   * @returns A partial client config carrying the project, or an empty object.
   */
  private static vertexProjectField(): { authOptions?: { projectId: string } } {
    const projectId = LLMProvider.resolveProjectId();
    return projectId ? { authOptions: { projectId } } : {};
  }

  /**
   * Publishes the resolved project into the environment Google's clients read.
   *
   * `GOOGLE_CLOUD_PROJECT` is the variable `google-auth-library` consults during
   * project detection, and it is the only lever that reaches every Google client
   * — including the ones Umbra does not construct itself. Setting it once here
   * is why a consumer project needs no Google settings of its own after
   * `umbra auth login --project X`.
   *
   * Nothing is overwritten: an explicitly configured project always wins. This
   * mirrors what `ensureVertexCredentials` already does with the credentials
   * path, which the Google SDK likewise requires in the environment.
   *
   * @returns Nothing.
   */
  private static publishProjectToEnvironment(): void {
    if (process.env.GOOGLE_CLOUD_PROJECT?.trim()) return;

    const projectId = LLMProvider.readAdcQuotaProject();
    if (projectId) process.env.GOOGLE_CLOUD_PROJECT = projectId;
  }

  /**
   * Resolves the Google Cloud project, falling back to what the login wrote.
   *
   * `GOOGLE_CLOUD_PROJECT` wins when set. When it is not — the normal case in a
   * consumer project whose `.env` has no Google settings — the project is read
   * from the local ADC file's `quota_project_id`, which is exactly what
   * `umbra auth login --project X` stores there.
   *
   * That fallback exists because Google's own detection does not use it: an
   * `authorized_user` ADC file carries `quota_project_id` and **no**
   * `project_id`, so the library reports "Unable to detect a Project Id" even
   * though the project the operator just authorized is sitting in the file.
   * Verified against a real ADC file on 2026-08-28.
   *
   * @returns The project id, or undefined when nothing declares one.
   */
  public static resolveProjectId(): string | undefined {
    return resolveVertexProject() ?? LLMProvider.readAdcQuotaProject();
  }

  /**
   * Reads `quota_project_id` from the local ADC file.
   *
   * Only that one field is read; no credential material is loaded, logged, or
   * returned. A missing, unreadable or malformed file yields undefined rather
   * than an error — the caller's job is to report the absence in its own words.
   *
   * @returns The quota project id, or undefined.
   */
  private static readAdcQuotaProject(): string | undefined {
    try {
      const adcPath = LLMProvider.getApplicationDefaultCredentialsPath();
      if (!fs.existsSync(adcPath)) return undefined;
      const parsed = JSON.parse(fs.readFileSync(adcPath, 'utf-8')) as {
        quota_project_id?: unknown;
      };
      const quotaProject = parsed.quota_project_id;
      return typeof quotaProject === 'string' && quotaProject.trim()
        ? quotaProject.trim()
        : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Reports whether either supported Google Application Default Credential
   * source is available without loading or printing credential contents.
   *
   * @returns True when a service-account file or local ADC file is present.
   */
  public static hasVertexCredentials(): boolean {
    const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (serviceAccountPath) {
      return fs.existsSync(path.resolve(rootDir, serviceAccountPath));
    }

    return fs.existsSync(LLMProvider.getApplicationDefaultCredentialsPath());
  }

  // ── Legacy Compatibility ───────────────────────────────────────────────────

  /**
   * @deprecated Use `createChatModel(model)` instead.
   * Kept for backward compatibility with old code that calls `LLMProvider.getModel()`.
   * Reads `GOOGLE_CLOUD_MODEL_NAME` env var for the model name.
   */
  public static getModel(): ChatVertexAI {
    LLMProvider.ensureVertexCredentials();
    return new VertexChatAdapter({
      model: process.env.GOOGLE_CLOUD_MODEL_NAME ?? 'gemini-2.5-flash-lite',
      temperature: 0,
      location: resolveVertexLocation(),
      ...LLMProvider.vertexProjectField(),
    });
  }

  /**
   * @deprecated Use `createChatModel(model)` instead.
   * Kept for backward compatibility with old code that calls `LLMProvider.createModel()`.
   */
  public static createModel(config?: {
    modelName?: string;
    temperature?: number;
  }): ChatVertexAI {
    LLMProvider.ensureVertexCredentials();
    return new VertexChatAdapter({
      model: config?.modelName ?? process.env.GOOGLE_CLOUD_MODEL_NAME ?? 'gemini-2.5-flash-lite',
      temperature: config?.temperature ?? 0,
      location: resolveVertexLocation(),
      ...LLMProvider.vertexProjectField(),
    });
  }

  // ── Private: Provider Factories ───────────────────────────────────────────

  /**
   * Creates a local `ChatOllama` instance.
   *
   * Strips the `"ollama:"` prefix from the model string before passing it
   * to `ChatOllama`, since the Ollama API only expects the bare model name
   * (e.g., "gemma4", not "ollama:gemma4").
   *
   * @param model - Full model string with `"ollama:"` prefix.
   * @param temperature - Sampling temperature.
   * @returns A configured `ChatOllama` instance.
   */
  /**
   * Creates a local `OllamaChatAdapter` instance.
   *
   * Uses `OllamaChatAdapter` (a transparent `ChatOllama` subclass) instead of
   * raw `ChatOllama`. The adapter serializes any non-string `ToolMessage` content
   * to JSON before forwarding to the Ollama API, which only accepts string content.
   *
   * This fixes the runtime crash:
   *   > Non string tool message content is not supported
   * that occurs when deepagents' built-in tools (e.g., `read_file`) return objects.
   *
   * Strips the `"ollama:"` prefix from the model string before passing it
   * to the adapter, since the Ollama API only expects the bare model name
   * (e.g., "gemma4:e2b", not "ollama:gemma4:e2b").
   *
   * @param model - Full model string with `"ollama:"` prefix.
   * @param temperature - Sampling temperature.
   * @returns A configured `OllamaChatAdapter` instance.
   */
  private static createOllamaModel(model: string, temperature: number): OllamaChatAdapter {
    // Strip "ollama:" prefix → "gemma4:e2b" (what Ollama API expects)
    const bareModelName = model.startsWith('ollama:') ? model.slice('ollama:'.length) : model;

    return new OllamaChatAdapter({
      model: bareModelName,
      baseUrl: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434',
      temperature,
    });
  }

  /**
   * Creates a `ChatVertexAI` instance with credential validation.
   *
   * @param model - The Gemini/Vertex model name (e.g., "gemini-2.5-flash").
   * @param temperature - Sampling temperature.
   * @returns A configured `ChatVertexAI` instance.
   * @throws {Error} If neither supported credential source is available.
   */
  private static createVertexModel(model: string, temperature: number): ChatVertexAI {
    LLMProvider.ensureVertexCredentials();
    return new VertexChatAdapter({
      model,
      temperature,
      location: resolveVertexLocation(),
      ...LLMProvider.vertexProjectField(),
      ...LLMProvider.geminiReasoningFields(model),
    });
  }

  /**
   * Translates Umbra's reasoning configuration into Gemini request fields.
   *
   * Gemini splits the same intent the way Claude does, along the same line:
   * the 3.x generation takes a named `thinkingLevel`, while 2.5 accepts only a
   * token budget and rejects the named form with an explicit `400`. Both
   * generations expose the reasoning text through `includeThoughts`.
   *
   * @param model - The bare Gemini model name, for capability lookup.
   * @returns Partial ChatVertexAI fields; empty when unconfigured.
   */
  private static geminiReasoningFields(model: string): {
    thinkingLevel?: 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH';
    thinkingBudget?: number;
  } {
    const { mechanism } = describeReasoning(model);
    if (mechanism === 'none') return {};

    const level = resolveReasoningLevel(model, resolveConfiguredReasoningLevel());
    if (!level) return {};

    // No `includeThoughts` is sent. `@langchain/google-common` does not accept
    // it as a parameter — it derives the flag from the token budget
    // (`utils/gemini.js`:896), so passing one is silently dropped. Umbra
    // therefore reports Gemini's display as not under its control rather than
    // offering a switch that would do nothing. See ADR-016.
    if (mechanism === 'thinking-level') {
      return { thinkingLevel: level.toUpperCase() as 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH' };
    }

    const budgetTokens = reasoningBudgetTokens(level);
    return budgetTokens === undefined ? {} : { thinkingBudget: budgetTokens };
  }

  /**
   * Validates that Google Application Default Credentials are configured.
   *
   * Resolves the credentials path relative to `process.cwd()` and sets the
   * absolute path back into the environment (required by the Google SDK).
   *
   * Supports either `GOOGLE_APPLICATION_CREDENTIALS` (service account) or the
   * local ADC file written by `gcloud auth application-default login`.
   *
   * @throws {Error} If neither credential source is available.
   * @throws {Error} If the credentials file does not exist at the resolved path.
   */
  private static ensureVertexCredentials(): void {
    // Credentials and project are established together: every Vertex path goes
    // through here, and ADC alone is not enough — an authorized_user file
    // authenticates the caller but declares no project.
    LLMProvider.publishProjectToEnvironment();

    const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

    if (!credentialsPath && fs.existsSync(LLMProvider.getApplicationDefaultCredentialsPath())) {
      return;
    }

    if (!credentialsPath) {
      throw new Error(
        '❌ Google Application Default Credentials are not configured. ' +
        'Run "umbra auth login --project <project-id>" for local development, ' +
        'or set GOOGLE_APPLICATION_CREDENTIALS for CI. ' +
        'For local inference, set AGENT_MODEL=ollama:<model> instead.',
      );
    }

    const absoluteCredentialsPath = path.resolve(rootDir, credentialsPath);

    if (!fs.existsSync(absoluteCredentialsPath)) {
      throw new Error(
        `❌ Credentials file not found at: ${absoluteCredentialsPath}. ` +
        'Check your GOOGLE_APPLICATION_CREDENTIALS path in .env.',
      );
    }

    // Normalize to absolute path — the Google SDK requires this.
    process.env.GOOGLE_APPLICATION_CREDENTIALS = absoluteCredentialsPath;
  }

  /**
   * Creates Claude through Anthropic's official Google Vertex AI client.
   *
   * The returned object is a real `ChatAnthropic` instance rather than a custom
   * subclass. DeepAgents uses that class identity to enable Anthropic prompt
   * caching and provider-specific message handling.
   *
   * @param model - Full `vertex-anthropic:*` model identifier.
   * @param temperature - Sampling temperature.
   * @returns A configured ChatAnthropic model backed by AnthropicVertex.
   * @throws Error when ADC or the explicit Google Cloud project is missing.
   */
  private static createVertexAnthropicModel(
    model: string,
    temperature: number,
  ): ChatAnthropic {
    LLMProvider.ensureVertexCredentials();
    const projectId = LLMProvider.resolveProjectId();
    if (!projectId) {
      throw new Error(
        '❌ GOOGLE_CLOUD_PROJECT is required for Claude on Vertex AI. ' +
        'Set it to the project where the Claude model is enabled.',
      );
    }

    const region = resolveVertexLocation();
    const vertexClient = new AnthropicVertex({ projectId, region, maxRetries: 0 });
    const modelName = getVertexAnthropicModelName(model);
    const reasoning = LLMProvider.anthropicReasoningFields(model);

    // Two independent reasons to drop `temperature`, and both are hard 400s.
    //
    // The Claude 5 generation removed the parameter outright. Claude 4.5 still
    // honors it — but not while thinking is enabled: Anthropic rejects the pair
    // with "temperature is not supported when thinking is enabled". So a Haiku
    // 4.5 selection with a reasoning level configured must also give up
    // deterministic sampling; it cannot have both.
    //
    // Neither case is sent-and-retried. Both are predictable from the request
    // Umbra is about to build, and a retry would spend a second paid call to
    // learn what is already known here.
    const omitTemperature = rejectsTemperature(modelName) || reasoning.thinking !== undefined;

    return new ChatAnthropic({
      model: modelName,
      ...(omitTemperature ? {} : { temperature }),
      // Cast confined to this spread: LangChain's `ChatAnthropicInput` omits
      // `xhigh` from `outputConfig.effort`, so its type would reject a level
      // the API accepts. `anthropicReasoningFields` carries its own explicit
      // return type, so the fields themselves are still checked — only
      // LangChain's stale union is bypassed.
      ...(reasoning as object),
      maxRetries: 0,
      createClient: () => vertexClient,
    });
  }

  /**
   * Translates Umbra's reasoning configuration into Anthropic request fields.
   *
   * The two Claude mechanisms need different shapes for the same intent:
   * the Claude 5 generation takes a named level in `outputConfig.effort` and
   * only returns readable reasoning when `display` is set to `summarized`,
   * while Claude 4.5 takes a token budget and returns its reasoning text
   * whenever thinking is enabled at all.
   *
   * Nothing is sent when the operator has configured nothing. That keeps the
   * provider default intact instead of Umbra silently choosing a depth.
   *
   * @param model - Full `vertex-anthropic:*` identifier, for capability lookup.
   * @returns Partial ChatAnthropic fields; empty when unconfigured.
   */
  private static anthropicReasoningFields(model: string): {
    outputConfig?: { effort: AnthropicEffort };
    thinking?:
      | { type: 'adaptive'; display?: 'summarized' }
      | { type: 'enabled'; budget_tokens: number; display?: 'summarized' };
  } {
    const { mechanism, display } = describeReasoning(model);
    const level = resolveReasoningLevel(model, resolveConfiguredReasoningLevel());
    const showReasoning = display === 'controllable' && resolveConfiguredReasoningDisplay();

    if (mechanism === 'effort') {
      return {
        // The cast is safe by construction: `resolveReasoningLevel` returns
        // only levels the model declares, and an `effort` model declares
        // exactly the five Anthropic accepts. `minimal` cannot reach here —
        // the live endpoint rejects it, and no effort model offers it.
        ...(level ? { outputConfig: { effort: level as AnthropicEffort } } : {}),
        ...(showReasoning
          ? { thinking: { type: 'adaptive' as const, display: 'summarized' as const } }
          : {}),
      };
    }

    if (mechanism === 'thinking-budget') {
      const budgetTokens = level ? reasoningBudgetTokens(level) : undefined;
      // Claude 4.5 carries depth and visibility in the same object, so a
      // display-only request still needs a budget to have anything to show.
      if (!budgetTokens) return {};
      return {
        thinking: {
          type: 'enabled' as const,
          budget_tokens: budgetTokens,
          ...(showReasoning ? { display: 'summarized' as const } : {}),
        },
      };
    }

    return {};
  }

  /**
   * Resolves the operating-system default location used by Google Cloud ADC.
   *
   * @returns The expected local Application Default Credentials file path.
   */
  private static getApplicationDefaultCredentialsPath(): string {
    if (process.platform === 'win32') {
      const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
      return path.join(appData, 'gcloud', 'application_default_credentials.json');
    }

    return path.join(os.homedir(), '.config', 'gcloud', 'application_default_credentials.json');
  }
}
