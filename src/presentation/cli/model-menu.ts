/**
 * @module ModelMenu
 *
 * Interactive terminal menu for switching the active LLM model at runtime.
 *
 * Renders a two-level menu:
 * 1. Provider selection: Gemini, Claude on Vertex AI, or Ollama
 * 2. Model selection: curated cloud presets or auto-detected Ollama models
 *
 * Triggered by typing `/model` in the chat session.
 *
 * ## Design Decisions
 * - No interactive UI dependency (`inquirer`, `prompts`) is used. The arrow-key
 *   navigation comes from `./interactive-select`, which is built on Node's own
 *   `readline` keypress decoder — see that module for the mechanism.
 * - **Every level has two paths.** On a real terminal the user navigates with
 *   the arrow keys. Without a TTY — piped input, CI, `< NUL` — there are no
 *   keystrokes to read and an arrow prompt would hang forever, so the original
 *   "type a number and press Enter" path is kept and used instead. It is a live
 *   fallback, not dead code.
 * - `detectOllamaModels()` is called on-demand (not at startup) so there's no
 *   startup latency for Vertex AI users.
 * - The menu marks the currently active model with `(active)` to orient the user,
 *   and the arrow prompt opens with the highlight already on it.
 * - Returns `null` if the user cancels (Escape, Ctrl+C, or `0`/empty in the
 *   numeric fallback) without switching.
 *
 * @example
 * ```ts
 * const newModel = await showModelMenu('gemini-2.5-flash-lite', rootDir);
 * if (newModel) {
 *   // user selected a new model — restart the agent
 * }
 * ```
 */

import { ModelSwitcher } from '../../core/config/model-switcher';
import { setConfiguredEmbeddingsProvider } from '../../core/config/agent-config-writer';
import { IndexerService } from '../../core/rag/indexer';
import { resolveEmbeddings, pinEmbeddingsProvider } from '../../core/rag/embeddings/embeddings-resolver';
import { probeEmbeddings } from '../../core/rag/embeddings/embeddings-availability';
import {
  isVertexAnthropicModel,
  isGoogleCloudProjectId,
  resolveVertexProject,
} from '../../core/config/model-resolver';
import {
  REASONING_DISPLAY_ENV,
  REASONING_LEVEL_ENV,
  ReasoningDisplaySupport,
  ReasoningLevel,
  describeReasoning,
  resolveConfiguredReasoningDisplay,
  resolveConfiguredReasoningLevel,
  resolveReasoningLevel,
} from '../../core/config/reasoning-profile';
import { colors, box } from './theme';
import { isInteractive, selectOutcome, SelectChoice } from './interactive-select';
import { askNumber as askNumberPrompt, askText, confirm } from './prompts';
import chalk from 'chalk';

/**
 * Result of the model selection menu.
 */
export interface ModelMenuResult {
  /** The new model string (e.g., "ollama:gemma4", "gemini-2.5-flash"). */
  model: string;
  /** True if the model was saved to .env successfully. */
  saved: boolean;
}

/**
 * Presents one level of the menu, choosing the interaction style for the
 * terminal at hand.
 *
 * On an interactive terminal this is an arrow-key prompt. Otherwise it prints
 * the numbered list and reads a number, which is the only thing that can work
 * when stdin is a pipe.
 *
 * Ctrl+C is treated as a cancellation of the menu rather than a session
 * shutdown: the user returns to the chat prompt, where a second Ctrl+C ends the
 * session through `ChatSession`'s own SIGINT handler.
 *
 * @typeParam T - The value carried by each row.
 * @param title - Section heading for this level.
 * @param choices - Rows to present. Separators are skipped by navigation and
 *                  are not numbered in the fallback.
 * @returns The chosen value, or `null` if the user cancelled.
 */
async function chooseFromList<T>(
  title: string,
  choices: SelectChoice<T>[],
): Promise<T | null> {
  if (isInteractive()) {
    console.log('');
    const outcome = await selectOutcome<T>({ title, choices });
    return outcome.status === 'selected' ? outcome.value : null;
  }

  // ── Fallback: numbered list + typed number ─────────────────────────────────
  printSection(title);

  const selectable = choices.filter((c) => !c.separator && !c.disabled);
  let numbered = 0;
  for (const choice of choices) {
    if (choice.separator) {
      console.log('');
      console.log(colors.secondary(`  ${choice.label}`));
      continue;
    }
    numbered++;
    const hint      = choice.hint   ? colors.muted(`  (${choice.hint})`) : '';
    const activeTag = choice.active ? colors.accent(' ← active')         : '';
    const label     = choice.disabled
      ? colors.dim(choice.label)
      : chalk.white(choice.label);
    console.log(`  ${colors.primary.bold(`${numbered}.`)} ${label}${hint}${activeTag}`);
  }
  console.log('');

  const picked = await askNumber('  Select: ', 0, selectable.length);
  if (picked === null || picked === 0) return null;
  return selectable[picked - 1].value as T;
}

/**
 * Displays the interactive model selection menu and returns the selected model.
 *
 * Shows a two-level menu: first pick a provider, then pick a specific model.
 * The selection is automatically persisted to `.env`; Claude selections also
 * persist their required Google Cloud project in the same write.
 *
 * @param currentModel - The currently active model string (highlighted as "active").
 * @param envFilePath - Absolute path to the `.env` file to update. Defaults to `process.cwd()/.env`.
 * @returns The selected `ModelMenuResult`, or `null` if the user cancelled.
 */
export async function showModelMenu(
  currentModel: string,
  envFilePath?: string,
): Promise<ModelMenuResult | null> {
  console.log('');
  printMenuBox('🔧  Switch LLM Model', interactiveHints());
  console.log('');

  // ── Step 1: Provider Selection ─────────────────────────────────────────────
  const isCurrentOllama = currentModel.startsWith('ollama:');
  const isCurrentClaude = isVertexAnthropicModel(currentModel);
  const providers: SelectChoice<'vertex-gemini' | 'vertex-anthropic' | 'ollama' | 'embeddings' | 'setup'>[] = [
    {
      // The distinguishing word leads each row. Both cloud providers share the
      // same Vertex AI transport, so starting both labels with it made them
      // scan as the same option; the shared part moves to the parenthetical.
      label: '⚡  Gemini  (Google — via Vertex AI)',
      value: 'vertex-gemini',
      active: !isCurrentOllama && !isCurrentClaude,
    },
    {
      label: '🟠  Claude  (Anthropic — via Vertex AI)',
      value: 'vertex-anthropic',
      active: isCurrentClaude,
    },
    {
      label: '🦙  Ollama  (Local — free, no API key needed)',
      value: 'ollama',
      active: isCurrentOllama,
    },
    {
      label: '🔎  Embeddings  (provider used to index and search code)',
      value: 'embeddings',
    },
    { label: '── configuration ──', separator: true },
    {
      label: '⚙️   Setup   (Google Cloud project and location)',
      value: 'setup',
    },
  ];

  const selectedProvider = await chooseFromList('Select Provider', providers);
  if (selectedProvider === null) {
    console.log(colors.muted('  Cancelled.\n'));
    return null;
  }

  // ── Step 2: Model Selection ────────────────────────────────────────────────
  if (selectedProvider === 'setup') {
    return showSetupMenu(envFilePath);
  }

  if (selectedProvider === 'embeddings') {
    return showEmbeddingsMenu();
  }

  if (selectedProvider === 'vertex-gemini') {
    return showVertexModelMenu(currentModel, envFilePath);
  } else if (selectedProvider === 'vertex-anthropic') {
    return showVertexClaudeModelMenu(currentModel, envFilePath);
  } else {
    return showOllamaModelMenu(currentModel, envFilePath);
  }
}

/**
 * Chooses and persists the provider that writes and reads semantic code
 * vectors. This changes no chat model and offers an explicit, fail-closed
 * confirmation before starting an index.
 *
 * @returns Always null because the current chat agent is unchanged.
 */
async function showEmbeddingsMenu(): Promise<null> {
  const active = resolveEmbeddings().port.identity.provider;
  const selected = await chooseFromList<'ollama' | 'vertex'>('Embeddings provider', [
    {
      label: '🦙  Ollama',
      value: 'ollama',
      hint: 'nomic-embed-text · local, free, offline',
      active: active === 'ollama',
    },
    {
      label: '☁️   Vertex',
      value: 'vertex',
      hint: 'text-embedding-004 · billable, needs Google credentials',
      active: active === 'vertex',
    },
  ]);
  if (selected === null) {
    console.log(colors.muted('  Cancelled.\n'));
    return null;
  }

  const saved = setConfiguredEmbeddingsProvider(process.cwd(), selected);
  if (!saved.saved) {
    console.log(colors.danger(`  ✗ Embeddings provider was not saved: ${saved.reason ?? 'unknown error'}\n`));
    return null;
  }

  // The resolver is process-wide; pinning makes this selection observable by
  // no-argument retrievers created later in this same CLI process.
  pinEmbeddingsProvider(selected);
  const selection = resolveEmbeddings();
  const availability = await probeEmbeddings(selection.port);
  console.log(colors.accent(`  ✓ Embeddings provider saved: ${selection.port.identity.provider}/${selection.port.identity.model}`));
  if (!availability.available) {
    console.log(colors.warning(`  ⚠️  Semantic indexing is unavailable: ${availability.reason ?? 'unknown reason'}`));
    console.log(colors.muted(`  Run: umbra index --embeddings ${selected} once the provider is available.`));
    console.log(colors.muted('  Existing vectors from the other provider are kept.\n'));
    return null;
  }

  const destination = selected === 'vertex'
    ? 'This sends repository code to Vertex AI and may incur charges. Build its index now?'
    : 'Build the local Ollama index now?';
  const shouldIndex = await confirm({
    question: destination,
    yesLabel: 'Build index now',
    noLabel: 'Keep provider only',
    defaultValue: false,
  });
  if (shouldIndex === true) {
    try {
      await new IndexerService(selection.port).indexProject();
      console.log(colors.accent(`  ✓ ${selection.port.identity.provider} index is ready.\n`));
      return null;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(colors.danger(`  ✗ Indexing failed: ${message}\n`));
      return null;
    }
  }

  console.log(colors.muted(`  Run: umbra index --embeddings ${selected} to build this provider's vectors.`));
  console.log(colors.muted('  Existing vectors from the other provider are kept.\n'));
  return null;
}

/**
 * Shows Claude models hosted by Google Vertex AI.
 *
 * @param currentModel - Currently active model for highlighting.
 * @param envFilePath - Path to `.env` for persistence.
 * @returns The selected model result, or null when cancelled.
 */
async function showVertexClaudeModelMenu(
  currentModel: string,
  envFilePath?: string,
): Promise<ModelMenuResult | null> {
  const choices: SelectChoice<string>[] = ModelSwitcher.getVertexClaudeModels().map(
    (entry) => ({
      label: entry.label,
      value: entry.name,
      active: entry.name === currentModel,
    }),
  );

  const selected = await chooseFromList('Select Claude Model', choices);
  if (selected === null) {
    console.log(colors.muted('  Cancelled.\n'));
    return null;
  }

  const projectId = await requestVertexProjectId();
  if (projectId === null) return null;

  process.env.GOOGLE_CLOUD_PROJECT = projectId;
  return await applyModelSelection(selected, envFilePath, projectId);
}

// ── Private: Vertex AI model submenu ─────────────────────────────────────────

/**
 * Shows the Vertex AI model submenu with curated Gemini presets.
 *
 * Entries from `getVertexModels()` with an empty `label` are treated as visual
 * family separators (e.g., "── Gemini 3.5 ──") and are displayed without a
 * selection number. Only real model entries are numbered and selectable.
 *
 * @param currentModel - Currently active model (for "active" highlighting).
 * @param envFilePath - Path to `.env` file for persistence.
 * @returns The selected model result, or `null` if cancelled.
 */
async function showVertexModelMenu(
  currentModel: string,
  envFilePath?: string,
): Promise<ModelMenuResult | null> {
  const allEntries = ModelSwitcher.getVertexModels();

  // An entry with an empty label is a family header, not a model. It becomes a
  // separator: rendered, but skipped by navigation and never numbered.
  const choices: SelectChoice<string>[] = allEntries.map((entry) =>
    entry.label === ''
      ? { label: entry.name, separator: true }
      : { label: entry.label, value: entry.name, active: entry.name === currentModel },
  );

  const selected = await chooseFromList('Select Gemini Model', choices);
  if (selected === null) {
    console.log(colors.muted('  Cancelled.\n'));
    return null;
  }

  return await applyModelSelection(selected, envFilePath);
}

// ── Private: Ollama model submenu ─────────────────────────────────────────────

/**
 * Shows the Ollama model submenu with auto-detected locally installed models.
 *
 * Calls `ollama list` to get the current list. If Ollama is not running,
 * shows a helpful error message and returns null.
 *
 * @param currentModel - Currently active model (for "active" highlighting).
 * @param envFilePath - Path to `.env` file for persistence.
 * @returns The selected model result, or `null` if cancelled.
 */
async function showOllamaModelMenu(
  currentModel: string,
  envFilePath?: string,
): Promise<ModelMenuResult | null> {
  process.stdout.write(colors.muted('  Detecting Ollama models... '));

  const ollamaModels = ModelSwitcher.detectOllamaModels();

  if (ollamaModels.length === 0) {
    console.log(colors.danger('✗'));
    console.log('');
    console.log(colors.warning('  ⚠️  No Ollama models detected.'));
    console.log(colors.muted('  Make sure Ollama is running: ') + chalk.cyan('ollama serve'));
    console.log(colors.muted('  Download a model: ') + chalk.cyan('ollama pull gemma4'));
    console.log('');
    return null;
  }

  console.log(colors.accent(`✓ (${ollamaModels.length} found)`));
  console.log('');

  const currentBareModel = currentModel.startsWith('ollama:')
    ? currentModel.slice('ollama:'.length)
    : currentModel;

  const choices: SelectChoice<string>[] = ollamaModels.map(
    (m: { name: string; size: string }) => ({
      label: m.name,
      value: m.name,
      hint: m.size,
      active: m.name === currentBareModel,
    }),
  );

  const selected = await chooseFromList('Select Ollama Model', choices);
  if (selected === null) {
    console.log(colors.muted('  Cancelled.\n'));
    return null;
  }

  const fullModelString = ModelSwitcher.toOllamaString(selected);
  return await applyModelSelection(fullModelString, envFilePath);
}

// ── Private: Reasoning submenu ────────────────────────────────────────────────

/**
 * What the operator chose on the reasoning screen.
 */
interface ReasoningChoice {
  /** The level to persist, or undefined to leave the model's own default. */
  level?: ReasoningLevel;
  /** Whether the model's reasoning should be shown in the terminal. */
  showReasoning: boolean;
}

/**
 * One row on the reasoning screen.
 *
 * The display toggle shares the list with the levels because both answer the
 * same question — how much thinking do I want, and do I want to see it — and
 * splitting them into two screens would make the cheap, reversible half feel
 * like a separate decision.
 */
type ReasoningRow =
  | { kind: 'level'; level: ReasoningLevel }
  | { kind: 'default' }
  | { kind: 'toggle-display' };

/** Human-readable guidance per level, shown as the row hint. */
const LEVEL_HINTS: Readonly<Record<ReasoningLevel, string>> = {
  minimal: 'barely thinks — cheapest, fastest',
  low: 'quick answers, simple tasks',
  medium: 'balanced',
  high: 'provider default — most coding work',
  xhigh: 'hard problems, agentic runs',
  max: 'correctness over cost',
};

/**
 * Why the display row is or is not actionable, in the operator's words.
 *
 * Corrected 2026-08-28. These read as they now behave, not as they were
 * designed: since the ADR-006 amendment, no provider's reasoning is printed at
 * all. The `controllable` toggle still changes the *request* — Anthropic is
 * asked for summarized thinking — and the CLI does not yet render what comes
 * back, which is recorded in `docs/deferred-work.md`. Saying so is the point:
 * this module's own rule is that a switch which silently does nothing is worse
 * than one that admits what it cannot do.
 */
const DISPLAY_HINTS: Readonly<Record<ReasoningDisplaySupport, string>> = {
  controllable: 'asks the provider for it — not printed yet; billed either way',
  'forced-on': 'always generated and billed once a level is set — not printed',
  unavailable: 'not available for this model',
};

/**
 * Renders the display row's checkbox for each support state.
 *
 * The box answers "is this reasoning shown to me?", so it is empty wherever
 * nothing reaches the screen. A `forced-on` model held a filled box until
 * 2026-08-28, on the understanding that its reasoning was always displayed;
 * the ADR-006 amendment stops printing it, so a filled box would now be a
 * claim the CLI does not honour. The hint carries why it cannot be filled.
 *
 * @param support - How much control Umbra has over showing reasoning.
 * @param showReasoning - The current toggle state, when it is controllable.
 * @returns The checkbox glyph to render.
 */
function displayCheckbox(support: ReasoningDisplaySupport, showReasoning: boolean): string {
  if (support === 'forced-on') return '☐';
  if (support === 'unavailable') return '☐';
  return showReasoning ? '☑' : '☐';
}

/**
 * Asks how hard the selected model should think, and whether to show it.
 *
 * Only the levels the chosen model actually accepts are offered, so a
 * selection can never produce the `400` that an unsupported level returns. A
 * model with no reasoning controls says so and is not prompted.
 *
 * The screen re-renders when the display toggle is used, so the operator sees
 * the new state before committing to a level.
 *
 * @param model - The model just selected.
 * @returns The chosen reasoning settings, or null when cancelled.
 */
async function chooseReasoning(model: string): Promise<ReasoningChoice | null> {
  const profile = describeReasoning(model);

  if (profile.mechanism === 'none') {
    console.log('');
    console.log(colors.muted('  Reasoning: not available for this model.'));
    return { level: undefined, showReasoning: false };
  }

  const controllable = profile.display === 'controllable';
  const activeLevel = resolveReasoningLevel(model, resolveConfiguredReasoningLevel());
  let showReasoning = controllable && resolveConfiguredReasoningDisplay();

  // Loop so the display toggle can be flipped without leaving the screen.
  for (;;) {
    const rows: SelectChoice<ReasoningRow>[] = [
      ...profile.levels.map((level) => ({
        label: `${level.padEnd(8)}`,
        value: { kind: 'level' as const, level },
        hint: LEVEL_HINTS[level],
        active: level === activeLevel,
      })),
      {
        label: 'default ',
        value: { kind: 'default' as const },
        hint: 'let the model decide',
        active: activeLevel === undefined,
      },
      { label: '── show reasoning ──', separator: true },
      {
        label: `${displayCheckbox(profile.display, showReasoning)}  Show the model's reasoning`,
        value: { kind: 'toggle-display' as const },
        hint: DISPLAY_HINTS[profile.display],
        disabled: !controllable,
      },
    ];

    const picked = await chooseFromList('Reasoning', rows);
    if (picked === null) return null;

    if (picked.kind === 'toggle-display') {
      showReasoning = !showReasoning;
      continue;
    }

    return {
      level: picked.kind === 'level' ? picked.level : undefined,
      showReasoning,
    };
  }
}

// ── Private: Setup submenu ────────────────────────────────────────────────────

/**
 * Shows the Google Cloud settings that no other screen can reach.
 *
 * The project ID is otherwise only asked for when it is missing, so an ID
 * entered wrongly once could only be fixed by editing `.env` by hand. The
 * region has never been reachable from the CLI at all.
 *
 * Reasoning is deliberately absent: it is chosen when a model is chosen, and a
 * second path to the same value is how two paths drift apart.
 *
 * @param envFilePath - Path to `.env` for persistence.
 * @returns Always null — setup changes configuration, never the model.
 */
async function showSetupMenu(envFilePath?: string): Promise<null> {
  const project = resolveVertexProject() ?? '(not set)';
  const location = process.env.GOOGLE_CLOUD_LOCATION?.trim() || 'global';

  const action = await chooseFromList<'project' | 'location'>('Setup', [
    {
      label: 'Google Cloud project',
      value: 'project',
      hint: project,
    },
    {
      label: 'Vertex AI location  ',
      value: 'location',
      hint: location,
    },
  ]);

  if (action === null) {
    console.log(colors.muted('  Cancelled.\n'));
    return null;
  }

  if (action === 'project') {
    console.log('');
    console.log(colors.muted('  Use the ID from the project selector, not its display name.'));
    const answer = await askText({
      prompt: colors.primary.bold('  Google Cloud project ID: '),
    });
    const projectId = answer?.trim() ?? '';
    if (!projectId) {
      console.log(colors.muted('  Cancelled.\n'));
      return null;
    }
    if (!isGoogleCloudProjectId(projectId)) {
      console.log(colors.danger('  ✗ Invalid Google Cloud project ID. Nothing was changed.\n'));
      return null;
    }
    reportSetupSave(
      ModelSwitcher.saveVertexSettingsToEnv({ projectId }, envFilePath),
      'GOOGLE_CLOUD_PROJECT',
      projectId,
    );
    process.env.GOOGLE_CLOUD_PROJECT = projectId;
    return null;
  }

  console.log('');
  console.log(colors.muted('  "global" is recommended. A specific region can hit its own quota.'));
  const answer = await askText({
    prompt: colors.primary.bold('  Vertex AI location: '),
  });
  const chosen = answer?.trim() ?? '';
  if (!chosen) {
    console.log(colors.muted('  Cancelled.\n'));
    return null;
  }
  if (!/^[a-z][a-z0-9-]*$/.test(chosen)) {
    console.log(colors.danger('  ✗ Invalid location. Nothing was changed.\n'));
    return null;
  }
  reportSetupSave(
    ModelSwitcher.saveVertexSettingsToEnv(
      { projectId: resolveVertexProject() ?? '', location: chosen },
      envFilePath,
    ),
    'GOOGLE_CLOUD_LOCATION',
    chosen,
  );
  process.env.GOOGLE_CLOUD_LOCATION = chosen;
  return null;
}

/**
 * Reports the outcome of a setup write.
 *
 * @param saved - Whether the write succeeded.
 * @param key - The environment key that was written.
 * @param value - The value that was written.
 */
function reportSetupSave(saved: boolean, key: string, value: string): void {
  console.log('');
  if (saved) {
    console.log(`  ${colors.accent('✅')} ${chalk.white(key)} ${colors.muted('=')} ${colors.primary.bold(value)}`);
    console.log(`  ${colors.muted('💾 Saved to .env')}`);
  } else {
    console.log(`  ${colors.warning(`⚠️  Could not save to .env — set ${key} manually.`)}`);
  }
  console.log('');
}

// ── Private: Apply selection ──────────────────────────────────────────────────

/**
 * Applies the selected model: saves to `.env` and prints confirmation.
 *
 * @param modelString - Full model string to set (e.g., "ollama:gemma4").
 * @param envFilePath - Path to `.env` file.
 * @param vertexProjectId - Project to persist atomically for Claude on Vertex.
 * @returns The `ModelMenuResult` with save status.
 */
async function applyModelSelection(
  modelString: string,
  envFilePath?: string,
  vertexProjectId?: string,
): Promise<ModelMenuResult | null> {
  // Reasoning is asked here, after the model is known, because this is the only
  // point in the flow where the legal levels are known. Asking earlier — or
  // from a separate command — would allow persisting a level the selected model
  // rejects, which is the same class of failure as a saved model with no
  // project: valid when written, broken on the next start.
  const reasoning = await chooseReasoning(modelString);
  if (reasoning === null) {
    console.log(colors.muted('  Cancelled.\n'));
    return null;
  }

  console.log('');
  console.log(`  ${colors.accent('✅')} ${chalk.white('Switching to')} ${colors.primary.bold(modelString)}`);
  if (reasoning.level) {
    console.log(`  ${colors.muted(`   reasoning: ${reasoning.level}`)}`);
  }
  if (reasoning.showReasoning) {
    console.log(`  ${colors.muted('   reasoning shown in the terminal')}`);
  }

  const saved = ModelSwitcher.saveSelectionToEnv(
    {
      model: modelString,
      reasoningLevel: reasoning.level,
      showReasoning: reasoning.showReasoning,
      projectId: vertexProjectId,
    },
    envFilePath,
  );

  // The agent is rebuilt inside this same process, so `.env` alone is not
  // enough: the provider reads these from `process.env` when it constructs the
  // new model. Without this, a switch would apply the previous selection's
  // reasoning settings to the newly chosen model.
  process.env[REASONING_LEVEL_ENV] = reasoning.level ?? '';
  process.env[REASONING_DISPLAY_ENV] = reasoning.showReasoning ? 'true' : 'false';

  if (saved) {
    console.log(`  ${colors.muted('💾 Saved to .env')}`);
  } else {
    console.log(`  ${colors.warning('⚠️  Could not save to .env — set AGENT_MODEL manually.')}`);
  }

  console.log(`  ${colors.muted('🔄 Restarting agent with new model...')}`);
  console.log('');

  return { model: modelString, saved };
}

/**
 * Resolves the project required by Anthropic's Vertex client.
 *
 * Existing valid configuration is reused without prompting. When it is absent
 * or malformed, the operator gets one focused question before any model switch
 * is persisted or restarted.
 *
 * @returns A valid Google Cloud project ID, or null when cancelled/invalid.
 */
async function requestVertexProjectId(): Promise<string | null> {
  const configured = resolveVertexProject();
  if (configured && isGoogleCloudProjectId(configured)) return configured;

  console.log('');
  console.log(colors.warning('  Claude on Vertex needs the Google Cloud project ID.'));
  console.log(colors.muted('  Use the ID from the project selector, not its display name.'));

  const answer = await askText({
    prompt: colors.primary.bold('  Google Cloud project ID: '),
  });
  const projectId = answer?.trim() ?? '';
  if (!projectId) {
    console.log(colors.muted('  Cancelled.\n'));
    return null;
  }
  if (!isGoogleCloudProjectId(projectId)) {
    console.log(colors.danger('  ✗ Invalid Google Cloud project ID. Nothing was changed.\n'));
    return null;
  }

  return projectId;
}

// ── Private: UI Helpers ───────────────────────────────────────────────────────

/**
 * Builds the header hint lines, which differ per interaction style.
 *
 * Telling a user on a pipe to "use the arrow keys" would be wrong, and telling
 * a user on a real terminal to "type the number" would understate what they
 * can do — so the hint is derived from the same check that picks the path.
 *
 * @returns The subtitle lines for the menu box.
 */
function interactiveHints(): string[] {
  return isInteractive()
    ? [
        '  Use ↑↓ to move, Enter to select.',
        '  Press Esc to cancel.',
      ]
    : [
        '  Type the number and press Enter.',
        '  Press 0 or Enter to cancel.',
      ];
}

/**
 * Prints a framed menu box with a title and optional subtitle lines.
 *
 * @param title - The box title.
 * @param lines - Optional subtitle lines inside the box.
 */
function printMenuBox(title: string, lines: string[] = []): void {
  const width = 52;
  console.log(colors.dim(box.topLeft + box.horizontal.repeat(width) + box.topRight));
  console.log(colors.dim(box.vertical) + colors.primary.bold('  ' + title.padEnd(width - 2)) + colors.dim(box.vertical));
  for (const line of lines) {
    console.log(colors.dim(box.vertical) + colors.muted(line.padEnd(width)) + colors.dim(box.vertical));
  }
  console.log(colors.dim(box.bottomLeft + box.horizontal.repeat(width) + box.bottomRight));
}

/**
 * Prints a section header inside the menu.
 *
 * @param label - The section name.
 */
function printSection(label: string): void {
  console.log(colors.secondary.bold(`  ${label}:`));
}

/**
 * Prompts the user for a numeric input within a given range.
 *
 * Kept as a thin wrapper rather than inlined at the call site: it fixes the
 * prompt styling for this menu, and it is the name the fallback path has always
 * been documented under. The readline lifetime and the range validation live in
 * `./prompts` (`askNumber`), so they are not re-implemented here.
 *
 * @param prompt - The prompt string to display.
 * @param min - Minimum valid value (inclusive).
 * @param max - Maximum valid value (inclusive).
 * @returns The parsed number, or `null` if input was empty/invalid.
 */
function askNumber(prompt: string, min: number, max: number): Promise<number | null> {
  return askNumberPrompt(colors.primary.bold(prompt), min, max);
}
