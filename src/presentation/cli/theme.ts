/**
 * @module theme
 *
 * CLI design system for Umbra.
 *
 * Centralizes all visual tokens: colors, icons, box-drawing characters,
 * and formatting utilities. Every visual element in the streaming CLI
 * derives from this file — change it here, changes everywhere.
 */

import chalk from 'chalk';

// ── Color Palette ────────────────────────────────────────────────────────────

/** Core brand colors used throughout the CLI. */
export const colors = {
  // Primary UI
  primary:    chalk.hex('#7C3AED'),  // Violet — agent identity
  secondary:  chalk.hex('#06B6D4'),  // Cyan — responses and info
  accent:     chalk.hex('#10B981'),  // Emerald — success / tools done
  warning:    chalk.hex('#F59E0B'),  // Amber — HITL / attention
  danger:     chalk.hex('#EF4444'),  // Red — errors
  muted:      chalk.hex('#6B7280'),  // Gray — secondary info / timings
  dim:        chalk.hex('#374151'),  // Dark gray — subtle borders

  // Agent types
  deep:         chalk.hex('#7C3AED'),  // Deep agent — violet
  orchestrator: chalk.hex('#EC4899'),  // Orchestrator — pink
  researcher:   chalk.hex('#06B6D4'),  // Researcher — cyan
  coder:        chalk.hex('#10B981'),  // Coder — emerald
};

/** Gradient-like bold labels for different modes. */
export const labels = {
  deep:         colors.deep.bold('⬡  DEEP'),
  orchestrator: colors.orchestrator.bold('⬡  ORCHESTRATE'),
  researcher:   colors.researcher.bold('⬡  RESEARCHER'),
  coder:        colors.coder.bold('⬡  CODER'),
  you:          chalk.white.bold('You'),
  agent:        colors.secondary.bold('Agent'),
};

// ── Icons ────────────────────────────────────────────────────────────────────

/**
 * Tool-specific icons shown in the tool call visualization.
 * Falls back to a wrench for unknown tools.
 */
export const toolIcons: Record<string, string> = {
  // Planning
  write_todos:   '📋',
  read_todos:    '📋',
  update_todo:   '✔️ ',

  // Filesystem (ours)
  safe_write_file: '💾',
  safe_read_file:  '📖',
  list_files:      '📂',

  // Filesystem (deepagents built-in)
  write_file:  '💾',
  read_file:   '📖',
  edit_file:   '✏️ ',
  ls:          '📂',

  // Analysis / RAG
  ask_codebase:         '🔍',
  refresh_project_index: '🔄',

  // Testing
  run_tests:             '🧪',
  run_integrity_check:   '🛡️ ',

  // SubAgents
  task:       '🤖',
  researcher: '🔍',
  coder:      '⚡',

  // Human
  ask_human: '✋',
};

/**
 * Returns the icon for a given tool name, with graceful fallback.
 *
 * @param toolName - The name of the tool being called.
 * @returns The emoji icon for that tool.
 */
export function getToolIcon(toolName: string): string {
  return toolIcons[toolName] ?? '🔧';
}

// ── Box Drawing ──────────────────────────────────────────────────────────────

/** Unicode box-drawing characters used in tool call visualizations. */
export const box = {
  topLeft:    '╭',
  topRight:   '╮',
  bottomLeft: '╰',
  bottomRight:'╯',
  horizontal: '─',
  vertical:   '│',
  leftT:      '├',
  rightT:     '┤',
  arrow:      '└─',
} as const;

// ── Spinners ─────────────────────────────────────────────────────────────────

/** Spinner frames for tool-in-progress animation. */
export const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// ── Formatting Utilities ─────────────────────────────────────────────────────

/**
 * Format a duration in milliseconds to a human-readable string.
 *
 * @param ms - Duration in milliseconds.
 * @returns Formatted string like "1.2s" or "450ms".
 */
export function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/**
 * Truncate a string to a maximum length, appending "…" if truncated.
 *
 * @param str - The string to truncate.
 * @param max - Maximum character count (default: 80).
 * @returns Truncated string.
 */
export function truncate(str: string, max = 80): string {
  const flat = String(str).replace(/\n/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max) + '…' : flat;
}

/**
 * Format tool input for display. Extracts the most meaningful field
 * to show as a one-liner preview.
 *
 * @param toolName - The tool name (used to pick the right key).
 * @param input - The raw tool input object.
 * @returns A short human-readable description of the input.
 */
export function formatToolInput(toolName: string, input: unknown): string {
  if (typeof input === 'string') return truncate(input);
  if (typeof input !== 'object' || input === null) return String(input);

  const obj = input as Record<string, unknown>;

  // Priority fields per tool
  const priority: Record<string, string[]> = {
    write_todos:       ['todos'],
    ask_codebase:      ['query'],
    safe_write_file:   ['file_path'],
    safe_read_file:    ['file_path'],
    write_file:        ['file_path'],
    read_file:         ['file_path'],
    edit_file:         ['file_path'],
    task:              ['subagent_type', 'description'],
    run_tests:         ['test_path'],
    ask_human:         ['question'],
  };

  const fields = priority[toolName] ?? Object.keys(obj);
  for (const field of fields) {
    if (obj[field] !== undefined) return truncate(String(obj[field]));
  }

  return truncate(JSON.stringify(obj));
}

// ── Session Header ────────────────────────────────────────────────────────────

/**
 * Build the welcome banner for a new chat session.
 *
 * @param mode - 'deep' | 'orchestrate'
 * @param model - The resolved model string.
 * @param sessionName - Named session being continued (undefined = new session).
 * @returns Multiline banner string ready to print.
 */
export function buildWelcomeBanner(
  mode: 'deep' | 'orchestrate',
  model: string,
  sessionName?: string,
): string {
  const title = mode === 'deep'
    ? colors.deep.bold('  Umbra — Deep Mode  ')
    : colors.orchestrator.bold('  Umbra — Orchestrator  ');

  const subtitle = mode === 'deep'
    ? colors.muted('  Single autonomous agent with planning tools  ')
    : colors.muted('  Researcher + Coder subagents coordinated  ');

  const modelLine = colors.muted(`  Model: ${chalk.white(model)}  `);

  const sessionLine = sessionName
    ? colors.muted(`  Session: ${chalk.white(sessionName)} ${colors.accent('(continuing)')}  `)
    : colors.muted(`  Session: ${chalk.hex('#F59E0B')('new')} ${colors.dim('(--session <name> to persist)')}  `);

  const hint = colors.dim('  Type your task. Ctrl+C to exit.  ');

  const width = 48;
  const top    = colors.dim('╭' + '─'.repeat(width) + '╮');
  const bottom = colors.dim('╰' + '─'.repeat(width) + '╯');
  const empty  = colors.dim('│' + ' '.repeat(width) + '│');

  return [
    '',
    top,
    empty,
    colors.dim('│') + title + colors.dim('│'),
    colors.dim('│') + subtitle + colors.dim('│'),
    colors.dim('│') + modelLine + colors.dim('│'),
    colors.dim('│') + sessionLine + colors.dim('│'),
    colors.dim('│') + hint + colors.dim('│'),
    empty,
    bottom,
    '',
  ].join('\n');
}

// ── Ollama CPU/RAM Warning ────────────────────────────────────────────────────

/**
 * Describes loaded Ollama model info for the warning display.
 * Intentionally minimal — only what we need for the warning block.
 */
export interface OllamaWarningInfo {
  /** Bare model name being loaded (e.g. "gemma4:e4b"). */
  model: string;
  /** Other models currently loaded in Ollama RAM. */
  loadedModels: Array<{ name: string; size: number }>;
  /** Whether more than one model is currently loaded (swap will occur). */
  requiresSwap: boolean;
}

/**
 * Builds a styled RAM/CPU warning block for Ollama models.
 *
 * Shown in the CLI before the first inference when Ollama is the active
 * provider. Informs the user that:
 * - Local models run on CPU (no dedicated GPU detected).
 * - Other models are loaded in RAM → a model swap will happen (slow).
 * - The first response will be slow (normal, not a bug).
 * - `gemma4:e2b` is a faster alternative if latency is a problem.
 *
 * @param info - RAM pressure data from `OllamaChatAdapter.preflight()`.
 * @returns Formatted warning block string, ready to `process.stdout.write()`.
 */
export function buildOllamaWarning(info: OllamaWarningInfo): string {
  const GB = (bytes: number) => `${(bytes / 1_073_741_824).toFixed(1)} GB`;

  const lines: string[] = [
    '',
    colors.warning.bold('  ⚠️  Ollama / CPU Mode — Read Before You Type'),
    '',
  ];

  if (info.requiresSwap && info.loadedModels.length > 0) {
    lines.push(
      colors.warning('  Models currently loaded in RAM:'),
    );
    for (const m of info.loadedModels) {
      const sizeLabel = m.size > 0 ? chalk.dim(` (${GB(m.size)})`) : '';
      lines.push(
        colors.muted(`    • ${chalk.white(m.name)}${sizeLabel}`),
      );
    }
    lines.push('');
    lines.push(
      colors.warning('  Ollama will need to swap models before responding.'),
    );
    lines.push(
      colors.muted('  This can take 1–3 minutes on CPU. This is normal.'),
    );
  } else {
    lines.push(
      colors.muted('  Running on CPU — first response may take 1–3 minutes.'),
    );
  }

  lines.push('');
  lines.push(
    colors.muted('  💡 Tip: ') +
    chalk.white('gemma4:e2b') +
    colors.muted(' (4B) is ~3× faster than ') +
    chalk.white('gemma4:e4b') +
    colors.muted(' on CPU.'),
  );
  lines.push(
    colors.muted('     Use ') +
    colors.primary('/model') +
    colors.muted(' to switch. Don\'t cancel — let it finish.'),
  );
  lines.push('');
  lines.push(colors.dim('  ' + '─'.repeat(52)));
  lines.push('');

  return lines.join('\n');
}
