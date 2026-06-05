/**
 * @module ModelSwitcher
 *
 * Utility for detecting locally installed Ollama models and persisting
 * the selected model to the project's `.env` file.
 *
 * This module is intentionally side-effect-free until explicitly called —
 * it does NOT auto-run on import.
 *
 * ## Design Decisions
 * - `detectOllamaModels()` shells out to `ollama list` to discover installed models.
 *   This is the most reliable way to get real-time model availability without
 *   maintaining a static list.
 * - `saveModelToEnv()` reads the existing `.env`, patches the `AGENT_MODEL` line,
 *   and writes it back. This preserves all other env vars untouched.
 * - We use `child_process.execSync` (not `spawn`) because `ollama list` is fast (<1s)
 *   and we want a synchronous result to keep the interactive menu simple.
 *
 * @example
 * ```ts
 * const models = ModelSwitcher.detectOllamaModels(); // ['gemma4', 'gemma4:26b', ...]
 * ModelSwitcher.saveModelToEnv('ollama:gemma4', '/path/to/project/.env');
 * ```
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Represents a locally installed Ollama model with its display metadata.
 */
export interface OllamaModel {
  /** The full model name as reported by `ollama list` (e.g., "gemma4:26b"). */
  name: string;
  /** Human-readable size string (e.g., "4.7 GB"). */
  size: string;
}

/**
 * Static utility class for model detection and `.env` persistence.
 *
 * All methods are static — no instantiation needed.
 * Designed to be called from the interactive `/model` menu in `ChatSession`.
 */
export class ModelSwitcher {
  /**
   * Detects all Ollama models currently installed on the local machine
   * by running `ollama list` as a child process.
   *
   * Parses stdout line-by-line. Each line after the header has the format:
   * ```
   * NAME              ID            SIZE      MODIFIED
   * gemma4:latest     abc123def456  4.7 GB    2 hours ago
   * ```
   *
   * @returns Array of `OllamaModel` objects. Empty array if Ollama is not
   *   installed, not running, or has no models downloaded.
   */
  public static detectOllamaModels(): OllamaModel[] {
    try {
      const output = execSync('ollama list', {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const lines = output.trim().split('\n');

      // Skip the header line ("NAME   ID   SIZE   MODIFIED")
      const dataLines = lines.slice(1);

      return dataLines
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => {
          // Columns are whitespace-separated. NAME is first, SIZE is third.
          const parts = line.split(/\s+/);
          const rawName = parts[0] ?? '';

          // Strip ":latest" suffix — it's the implicit default and confuses users.
          // "gemma4:latest" → "gemma4", "gemma4:26b" stays "gemma4:26b"
          const name = rawName.endsWith(':latest')
            ? rawName.slice(0, -':latest'.length)
            : rawName;

          // Size is at index 2 (e.g., "4.7") and units at index 3 (e.g., "GB")
          const size =
            parts[2] && parts[3]
              ? `${parts[2]} ${parts[3]}`
              : parts[2] ?? 'unknown';

          return { name, size };
        })
        .filter((m) => m.name.length > 0);
    } catch {
      // Ollama not installed, not running, or timed out.
      // Return empty array — the menu will show a helpful message.
      return [];
    }
  }

  /**
   * Checks if Ollama is running and reachable on localhost.
   *
   * Uses `ollama list` as a lightweight probe. Returns false if the command
   * fails (Ollama not installed, not started, or port blocked).
   *
   * @returns True if Ollama is running and available.
   */
  public static isOllamaRunning(): boolean {
    try {
      execSync('ollama list', { timeout: 3000, stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Writes or updates the `AGENT_MODEL` variable in the given `.env` file.
   *
   * - If `AGENT_MODEL=...` already exists in the file, the line is replaced in-place.
   * - If it does not exist, it is appended at the end of the file.
   * - All other env vars are preserved exactly as-is (no reformatting).
   *
   * @param modelString - The full model string to set (e.g., `"ollama:gemma4"`, `"gemini-2.5-flash"`).
   * @param envFilePath - Absolute path to the `.env` file to modify.
   *   Defaults to `process.cwd() + "/.env"`.
   * @returns True if the write succeeded, false on any error.
   */
  public static saveModelToEnv(
    modelString: string,
    envFilePath?: string,
  ): boolean {
    const filePath = envFilePath ?? path.join(process.cwd(), '.env');

    try {
      let content = '';

      // Read existing file if it exists
      if (fs.existsSync(filePath)) {
        content = fs.readFileSync(filePath, 'utf-8');
      }

      const agentModelLine = `AGENT_MODEL=${modelString}`;

      if (/^AGENT_MODEL=.*/m.test(content)) {
        // Replace existing AGENT_MODEL line
        content = content.replace(/^AGENT_MODEL=.*/m, agentModelLine);
      } else {
        // Append at the end, ensuring a newline before if needed
        const separator = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
        content = `${content}${separator}${agentModelLine}\n`;
      }

      fs.writeFileSync(filePath, content, 'utf-8');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Builds the full `deepagents`-compatible model string for the Ollama provider.
   *
   * `deepagents` uses `"ollama:<modelName>"` as the provider format.
   * This method ensures consistent formatting regardless of whether the caller
   * already includes the `"ollama:"` prefix.
   *
   * @param modelName - The model name, with or without "ollama:" prefix.
   * @returns The canonical `"ollama:<modelName>"` string.
   * @example
   * ModelSwitcher.toOllamaString('gemma4')         // 'ollama:gemma4'
   * ModelSwitcher.toOllamaString('ollama:gemma4')  // 'ollama:gemma4'
   */
  public static toOllamaString(modelName: string): string {
    return modelName.startsWith('ollama:') ? modelName : `ollama:${modelName}`;
  }

  /**
   * Returns the list of Vertex AI / Gemini cloud models available as presets.
   *
   * Curated list organized by model family (newest first).
   * Entries with an empty name (`''`) are visual separators between families.
   *
   * These are not auto-detected (no cloud API call needed) — they are curated
   * and kept in sync with the `MODEL_TIERS` defined in `model-resolver.ts`.
   *
   * @returns Array of Vertex AI model presets with display metadata.
   */
  public static getVertexModels(): Array<{ name: string; label: string }> {
    return [
      // ── Gemini 3.5 (latest) ───────────────────────────────────────────────
      { name: '── Gemini 3.5 ──',       label: '' },
      { name: 'gemini-3.5-flash',       label: 'Gemini 3.5 Flash      ⭐ (fastest, agentic)' },

      // ── Gemini 3.1 ────────────────────────────────────────────────────────
      { name: '── Gemini 3.1 ──',       label: '' },
      { name: 'gemini-3.1-flash-lite',  label: 'Gemini 3.1 Flash Lite   (cheap, high-volume)' },
      { name: 'gemini-3.1-pro',         label: 'Gemini 3.1 Pro          (complex reasoning)' },

      // ── Gemini 2.5 ────────────────────────────────────────────────────────
      { name: '── Gemini 2.5 ──',       label: '' },
      { name: 'gemini-2.5-flash-lite',  label: 'Gemini 2.5 Flash Lite   (fast & cheap)' },
      { name: 'gemini-2.5-flash',       label: 'Gemini 2.5 Flash        (balanced)' },
      { name: 'gemini-2.5-pro',         label: 'Gemini 2.5 Pro          (most capable 2.5)' },
    ];
  }
}
