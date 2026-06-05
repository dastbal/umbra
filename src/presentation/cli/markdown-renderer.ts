/**
 * @module MarkdownRenderer
 *
 * Transforms the agent's markdown response text into richly styled terminal
 * output using chalk.
 *
 * The LLM outputs standard markdown. This renderer intercepts the final
 * accumulated response and converts it line-by-line before printing, so
 * the user sees beautiful formatted text instead of raw `**bold**` syntax.
 *
 * ## Supported syntax:
 * - `# H1`, `## H2`, `### H3` — bold headers with color + blank lines around
 * - `**bold**` / `__bold__`   — bold white
 * - `*italic*` / `_italic_`   — italic dim
 * - `` `inline code` ``       — cyan monospace-style
 * - ` ```code block``` `      — full bordered box (╭──╮ / ╰──╯)
 * - `- item` / `* item`       — bullet list with accent dot
 * - `1. item`                 — numbered list
 * - `---`                     — dim separator line
 * - `✅ Step N done —`         — autonomous execution progress marker
 *
 * ## Visual conventions
 * - 2-space left margin on ALL output lines
 * - Blank line injected before AND after every header
 * - Code blocks enclosed in full Unicode box borders
 *
 * @example
 * ```ts
 * const renderer = new MarkdownRenderer();
 * const styled = renderer.render(agentResponseText);
 * process.stdout.write(styled);
 * ```
 */

import chalk from 'chalk';
import { colors } from './theme';

/** Left margin applied to every output line. */
const INDENT = '  ';
/** Width of code block borders (characters). */
const CODE_BOX_WIDTH = 56;

/**
 * Renders markdown-formatted agent responses to chalk-styled terminal strings.
 *
 * Stateful: tracks whether we are inside a fenced code block (` ``` `).
 * Create a new instance per-response to avoid state leakage between turns.
 */
export class MarkdownRenderer {
  /** Whether we are currently inside a fenced code block. */
  private inCodeBlock = false;
  /** Language hint from the opening fence (e.g., "typescript"). */
  private codeBlockLang = '';

  /**
   * Render a full markdown string to chalk-styled terminal output.
   *
   * @param text - Raw markdown text from the LLM.
   * @returns Styled string ready to write to stdout.
   */
  public render(text: string): string {
    const lines = text.split('\n');
    const rendered: string[] = [];

    for (const line of lines) {
      const result = this.renderLine(line);
      // Headers return an array (blank + header + blank), others return a string
      if (Array.isArray(result)) {
        rendered.push(...result);
      } else {
        rendered.push(result);
      }
    }

    return rendered.join('\n');
  }

  // ── Private: Line-by-line Rendering ────────────────────────────────────────

  /**
   * Render a single line of markdown.
   * Returns a string array when blank padding lines need to be injected (headers).
   *
   * @param line - One line of the raw markdown text.
   * @returns Chalk-styled string (or array of strings for headers).
   */
  private renderLine(line: string): string | string[] {
    // ── Fenced code block handling ──────────────────────────────────────────
    if (line.trimStart().startsWith('```')) {
      if (this.inCodeBlock) {
        // Closing fence → bottom border
        this.inCodeBlock = false;
        this.codeBlockLang = '';
        return INDENT + colors.dim('╰' + '─'.repeat(CODE_BOX_WIDTH) + '╯');
      } else {
        // Opening fence → top border with language label
        this.inCodeBlock = true;
        this.codeBlockLang = line.trim().slice(3).trim();
        const langLabel = this.codeBlockLang
          ? chalk.hex('#94A3B8')(` ${this.codeBlockLang} `)
          : '';
        const borderRight = '─'.repeat(Math.max(0, CODE_BOX_WIDTH - this.codeBlockLang.length - 2));
        return INDENT + colors.dim('╭─') + langLabel + colors.dim(borderRight + '╮');
      }
    }

    if (this.inCodeBlock) {
      // Inside a code block: border + indent + cyan code
      return INDENT + colors.dim('│ ') + chalk.cyan(line);
    }

    // ── Horizontal rule ─────────────────────────────────────────────────────
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      return INDENT + colors.dim('─'.repeat(50));
    }

    // ── Headers (with blank lines before + after) ────────────────────────────
    const h1 = line.match(/^# (.+)/);
    if (h1) {
      const styled = colors.primary.bold('  ★  ' + h1[1].toUpperCase());
      return ['', INDENT + styled, ''];
    }

    const h2 = line.match(/^## (.+)/);
    if (h2) {
      const styled = colors.secondary.bold('  ◈  ' + h2[1]);
      return ['', INDENT + styled, ''];
    }

    const h3 = line.match(/^### (.+)/);
    if (h3) {
      const styled = chalk.white.bold('  ›  ' + h3[1]);
      return ['', INDENT + styled, ''];
    }

    // ── Autonomous step markers (from our system prompt format) ─────────────
    if (line.startsWith('✅')) {
      return INDENT + colors.accent.bold(line);
    }

    // ── Bullet lists ────────────────────────────────────────────────────────
    const bullet = line.match(/^(\s*)[*\-+] (.+)/);
    if (bullet) {
      const extraIndent = bullet[1];
      const content = this.renderInline(bullet[2]);
      return INDENT + `${extraIndent}${colors.accent('◆')} ${content}`;
    }

    // ── Numbered lists ───────────────────────────────────────────────────────
    const numbered = line.match(/^(\s*)(\d+)\. (.+)/);
    if (numbered) {
      const extraIndent = numbered[1];
      const num = colors.primary.bold(`${numbered[2]}.`);
      const content = this.renderInline(numbered[3]);
      return INDENT + `${extraIndent}${num} ${content}`;
    }

    // ── Blockquote ───────────────────────────────────────────────────────────
    const quote = line.match(/^> (.+)/);
    if (quote) {
      return INDENT + colors.dim('│ ') + colors.muted(this.renderInline(quote[1]));
    }

    // ── Empty line ───────────────────────────────────────────────────────────
    if (line.trim() === '') return '';

    // ── Regular paragraph line ───────────────────────────────────────────────
    return INDENT + this.renderInline(line);
  }

  /**
   * Apply inline styles (bold, italic, code) to a single text span.
   *
   * Processes in order: inline code first (to avoid styling inside backticks),
   * then bold, then italic.
   *
   * @param text - A single line or span of text.
   * @returns Chalk-styled string.
   */
  private renderInline(text: string): string {
    // Inline code — process first so inner content is not re-styled
    text = text.replace(/`([^`]+)`/g, (_match, code) => chalk.cyan(code));

    // Bold + italic combined: ***text***
    text = text.replace(/\*\*\*(.+?)\*\*\*/g, (_match, t) => chalk.bold.italic(t));

    // Bold: **text** or __text__
    text = text.replace(/\*\*(.+?)\*\*/g, (_match, t) => chalk.white.bold(t));
    text = text.replace(/__(.+?)__/g, (_match, t) => chalk.white.bold(t));

    // Italic: *text* or _text_  (careful: only single * not already matched)
    text = text.replace(/\*([^*]+?)\*/g, (_match, t) => chalk.italic(t));
    text = text.replace(/_([^_]+?)_/g, (_match, t) => chalk.italic(t));

    // Return as plain white (default body text color)
    return chalk.white(text);
  }
}
