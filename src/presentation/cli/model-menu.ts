/**
 * @module ModelMenu
 *
 * Interactive terminal menu for switching the active LLM model at runtime.
 *
 * Renders a two-level menu:
 * 1. Provider selection: Vertex AI (cloud) or Ollama (local)
 * 2. Model selection: curated Vertex presets OR auto-detected Ollama models
 *
 * Triggered by typing `/model` in the chat session.
 *
 * ## Design Decisions
 * - Uses raw `readline` (not `inquirer` or `prompts`) to stay consistent with
 *   the rest of the CLI and avoid adding heavy interactive UI dependencies.
 * - `detectOllamaModels()` is called on-demand (not at startup) so there's no
 *   startup latency for Vertex AI users.
 * - The menu marks the currently active model with `(active)` to orient the user.
 * - Returns `null` if the user cancels (types 0 or empty) without switching.
 *
 * @example
 * ```ts
 * const newModel = await showModelMenu('gemini-2.5-flash-lite', rootDir);
 * if (newModel) {
 *   // user selected a new model — restart the agent
 * }
 * ```
 */

import * as readline from 'readline';
import { ModelSwitcher } from '../../core/config/model-switcher';
import { colors, box } from './theme';
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
 * Displays the interactive model selection menu and returns the selected model.
 *
 * Shows a two-level menu: first pick a provider, then pick a specific model.
 * The selection is automatically persisted to `.env` via `ModelSwitcher.saveModelToEnv()`.
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
  printMenuBox('🔧  Switch LLM Model', [
    '  Type the number and press Enter.',
    '  Press 0 or Enter to cancel.',
  ]);
  console.log('');

  // ── Step 1: Provider Selection ─────────────────────────────────────────────
  const providers = [
    { key: '1', label: '⚡  Vertex AI  (Gemini cloud — requires Google credentials)', value: 'vertex' },
    { key: '2', label: '🦙  Ollama     (Local models — free, no API key needed)',     value: 'ollama' },
  ];

  printSection('Select Provider');
  const isCurrentOllama = currentModel.startsWith('ollama:');
  providers.forEach((p) => {
    const isActive = (p.value === 'ollama' && isCurrentOllama) ||
                     (p.value === 'vertex' && !isCurrentOllama);
    const activeTag = isActive ? colors.accent(' ← active') : '';
    console.log(`  ${colors.primary.bold(p.key + '.')} ${chalk.white(p.label)}${activeTag}`);
  });

  const providerChoice = await askNumber('  Provider: ', 0, providers.length);
  if (providerChoice === null || providerChoice === 0) {
    console.log(colors.muted('  Cancelled.\n'));
    return null;
  }

  const selectedProvider = providers[providerChoice - 1];
  console.log('');

  // ── Step 2: Model Selection ────────────────────────────────────────────────
  if (selectedProvider.value === 'vertex') {
    return showVertexModelMenu(currentModel, envFilePath);
  } else {
    return showOllamaModelMenu(currentModel, envFilePath);
  }
}

// ── Private: Vertex AI model submenu ─────────────────────────────────────────

/**
 * Shows the Vertex AI model submenu with curated Gemini presets.
 *
 * @param currentModel - Currently active model (for "active" highlighting).
 * @param envFilePath - Path to `.env` file for persistence.
 * @returns The selected model result, or `null` if cancelled.
 */
async function showVertexModelMenu(
  currentModel: string,
  envFilePath?: string,
): Promise<ModelMenuResult | null> {
  const models = ModelSwitcher.getVertexModels();

  printSection('Select Gemini Model');
  models.forEach((m: { name: string; label: string }, i: number) => {
    const isActive = m.name === currentModel;
    const activeTag = isActive ? colors.accent(' ← active') : '';
    console.log(`  ${colors.primary.bold(`${i + 1}.`)} ${chalk.white(m.label)}${activeTag}`);
  });

  const choice = await askNumber('  Model: ', 0, models.length);
  if (choice === null || choice === 0) {
    console.log(colors.muted('  Cancelled.\n'));
    return null;
  }

  const selected = models[choice - 1];
  return applyModelSelection(selected.name, envFilePath);
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

  printSection('Select Ollama Model');

  const currentBareModel = currentModel.startsWith('ollama:')
    ? currentModel.slice('ollama:'.length)
    : currentModel;

  ollamaModels.forEach((m: { name: string; size: string }, i: number) => {
    const isActive = m.name === currentBareModel;
    const activeTag  = isActive ? colors.accent(' ← active') : '';
    const sizeLabel  = colors.muted(`  (${m.size})`);
    console.log(
      `  ${colors.primary.bold(`${i + 1}.`)} ${chalk.white(m.name)}${sizeLabel}${activeTag}`,
    );
  });

  const choice = await askNumber('  Model: ', 0, ollamaModels.length);
  if (choice === null || choice === 0) {
    console.log(colors.muted('  Cancelled.\n'));
    return null;
  }

  const selected = ollamaModels[choice - 1];
  const fullModelString = ModelSwitcher.toOllamaString(selected.name);
  return applyModelSelection(fullModelString, envFilePath);
}

// ── Private: Apply selection ──────────────────────────────────────────────────

/**
 * Applies the selected model: saves to `.env` and prints confirmation.
 *
 * @param modelString - Full model string to set (e.g., "ollama:gemma4").
 * @param envFilePath - Path to `.env` file.
 * @returns The `ModelMenuResult` with save status.
 */
function applyModelSelection(
  modelString: string,
  envFilePath?: string,
): ModelMenuResult {
  console.log('');
  console.log(`  ${colors.accent('✅')} ${chalk.white('Switching to')} ${colors.primary.bold(modelString)}`);

  const saved = ModelSwitcher.saveModelToEnv(modelString, envFilePath);

  if (saved) {
    console.log(`  ${colors.muted('💾 Saved to .env')}`);
  } else {
    console.log(`  ${colors.warning('⚠️  Could not save to .env — set AGENT_MODEL manually.')}`);
  }

  console.log(`  ${colors.muted('🔄 Restarting agent with new model...')}`);
  console.log('');

  return { model: modelString, saved };
}

// ── Private: UI Helpers ───────────────────────────────────────────────────────

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
 * Uses a short-lived readline (closed immediately after input) to avoid
 * interfering with the streaming output.
 *
 * @param prompt - The prompt string to display.
 * @param min - Minimum valid value (inclusive).
 * @param max - Maximum valid value (inclusive).
 * @returns The parsed number, or `null` if input was empty/invalid.
 */
function askNumber(prompt: string, min: number, max: number): Promise<number | null> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(colors.primary.bold(prompt), (answer) => {
      rl.close();
      const trimmed = answer.trim();
      if (!trimmed) { resolve(null); return; }
      const num = parseInt(trimmed, 10);
      if (isNaN(num) || num < min || num > max) {
        console.log(colors.warning(`  Invalid choice. Please enter a number between ${min} and ${max}.`));
        resolve(null);
      } else {
        resolve(num);
      }
    });
  });
}
