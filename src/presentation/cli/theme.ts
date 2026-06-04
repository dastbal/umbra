/**
 * @module theme
 *
 * CLI Design System for nestjs-ai-agent-lib.
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
 * @returns Multiline banner string ready to print.
 */
export function buildWelcomeBanner(mode: 'deep' | 'orchestrate', model: string): string {
  const title = mode === 'deep'
    ? colors.deep.bold('  NestJS AI Agent — Deep Mode  ')
    : colors.orchestrator.bold('  NestJS AI Agent — Orchestrator  ');

  const subtitle = mode === 'deep'
    ? colors.muted('  Single autonomous agent with planning tools  ')
    : colors.muted('  Researcher + Coder subagents coordinated  ');

  const modelLine = colors.muted(`  Model: ${chalk.white(model)}  `);
  const hint = colors.dim('  Type your task. Press Ctrl+C to exit.  ');

  const width = 46;
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
    empty,
    colors.dim('│') + hint + colors.dim('│'),
    empty,
    bottom,
    '',
  ].join('\n');
}
