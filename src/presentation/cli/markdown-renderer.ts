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
 * - `# H1`, `## H2`, `### H3` — bold headers with color
 * - `**bold**` / `__bold__`   — bold white
 * - `*italic*` / `_italic_`   — italic dim
 * - `` `inline code` ``       — cyan monospace-style
 * - ` ```code block``` `      — indented cyan block
 * - `- item` / `* item`       — bullet list with accent dot
 * - `1. item`                 — numbered list
 * - `---`                     — dim separator line
 * - `✅ Step N done —`         — autonomous execution progress marker
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
    return lines.map(line => this.renderLine(line)).join('\n');
  }

  // ── Private: Line-by-line Rendering ────────────────────────────────────────

  /**
   * Render a single line of markdown.
   *
   * @param line - One line of the raw markdown text.
   * @returns Chalk-styled string for that line.
   */
  private renderLine(line: string): string {
    // ── Fenced code block handling ──────────────────────────────────────────
    if (line.trimStart().startsWith('```')) {
      if (this.inCodeBlock) {
        // Closing fence
        this.inCodeBlock = false;
        this.codeBlockLang = '';
        return colors.dim('   ' + '─'.repeat(44));
      } else {
        // Opening fence — extract language hint
        this.inCodeBlock = true;
        this.codeBlockLang = line.trim().slice(3).trim();
        const langLabel = this.codeBlockLang
          ? colors.muted(` [${this.codeBlockLang}]`)
          : '';
        return colors.dim('   ' + '─'.repeat(44)) + langLabel;
      }
    }

    if (this.inCodeBlock) {
      // Inside a code block: indent + cyan
      return chalk.cyan('  ' + line);
    }

    // ── Horizontal rule ─────────────────────────────────────────────────────
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      return colors.dim('─'.repeat(50));
    }

    // ── Headers ─────────────────────────────────────────────────────────────
    const h3 = line.match(/^### (.+)/);
    if (h3) return chalk.white.bold(h3[1]);

    const h2 = line.match(/^## (.+)/);
    if (h2) return colors.secondary.bold(h2[1]);

    const h1 = line.match(/^# (.+)/);
    if (h1) return colors.primary.bold('★  ' + h1[1]);

    // ── Autonomous step markers (from our system prompt format) ─────────────
    // Matches: "✅ Step N done — ..." or "✅ Step N..."
    if (line.startsWith('✅')) {
      return colors.accent.bold(line);
    }

    // ── Bullet lists ────────────────────────────────────────────────────────
    const bullet = line.match(/^(\s*)[*\-+] (.+)/);
    if (bullet) {
      const indent = bullet[1];
      const content = this.renderInline(bullet[2]);
      return `${indent}${colors.accent('◆')} ${content}`;
    }

    // ── Numbered lists ───────────────────────────────────────────────────────
    const numbered = line.match(/^(\s*)(\d+)\. (.+)/);
    if (numbered) {
      const indent = numbered[1];
      const num = colors.primary.bold(`${numbered[2]}.`);
      const content = this.renderInline(numbered[3]);
      return `${indent}${num} ${content}`;
    }

    // ── Blockquote ───────────────────────────────────────────────────────────
    const quote = line.match(/^> (.+)/);
    if (quote) {
      return colors.dim('│ ') + colors.muted(this.renderInline(quote[1]));
    }

    // ── Regular paragraph line ───────────────────────────────────────────────
    return this.renderInline(line);
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
