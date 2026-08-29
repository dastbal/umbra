/**
 * @module StreamRenderer
 *
 * Real-time terminal renderer for the streaming AI agent CLI.
 *
 * Decoupled from the agent: receives semantic events (token, toolStart, toolEnd)
 * and renders them to stdout. The session manager (ChatSession) calls these methods
 * as events arrive from the LangGraph streamEvents() API.
 *
 * Visual output mimics premium AI CLIs (Claude, Gemini):
 * - Tokens stream character-by-character as they're generated
 * - Tool calls appear in a bordered box with a live spinner
 * - Tool completions show elapsed time
 * - Final responses are cleanly boxed and separated from tool noise
 */

import chalk from 'chalk';
import {
  colors,
  box,
  spinnerFrames,
  formatDuration,
  formatToolInput,
  getToolIcon,
  getToolPhrase,
  labels,
  shimmerRamp,
  SHIMMER_TAIL,
  thinkingPhrases,
  type ThinkingPhase,
} from './theme';
import { MarkdownRenderer } from './markdown-renderer';

/** Internal state for a tool call currently in progress. */
interface ActiveTool {
  /** Tool name */
  name: string;
  /** Display string (icon + name) */
  label: string;
  /** Wait-state phrase shown next to the spinner (e.g. "Reading the file") */
  phrase: string;
  /** Timestamp when the tool call started */
  startedAt: number;
  /** Current spinner frame index */
  frame: number;
  /** Interval handle for spinner animation, or null on non-interactive stdout */
  interval: NodeJS.Timeout | null;
}

/** Milliseconds between shimmer frames. ~16 fps — smooth without churn. */
const SHIMMER_TICK_MS = 60;

/**
 * Idle frames appended to every shimmer cycle, so the light sweeps across the
 * phrase, rests, then sweeps again instead of looping without a seam.
 */
const SHIMMER_PAUSE = 14;

/**
 * StreamRenderer — Renders LangGraph streaming events to the terminal.
 *
 * Usage:
 * ```ts
 * const renderer = new StreamRenderer('deep');
 *
 * for await (const event of agent.streamEvents(input, config, { version: 'v2' })) {
 *   switch (event.event) {
 *     case 'on_chat_model_stream':
 *       renderer.streamToken(event.data.chunk.content ?? '');
 *       break;
 *     case 'on_tool_start':
 *       renderer.showToolStart(event.name, event.data.input);
 *       break;
 *     case 'on_tool_end':
 *       renderer.showToolEnd(event.name);
 *       break;
 *   }
 * }
 *
 * renderer.finalizeTurn();
 * ```
 */
/**
 * Renders a token count compactly enough for a one-line wait indicator.
 *
 * @param tokens - Total tokens observed for the turn.
 * @returns "51.0k" above a thousand, the plain integer below it.
 */
function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

export class StreamRenderer {
  /** Whether we are currently streaming tokens (affects newline handling). */
  private isStreaming = false;
  /** Whether any token has been printed in the current turn. */
  private hasStreamedContent = false;
  /** Currently active tool call (only one at a time). */
  private activeTool: ActiveTool | null = null;
  /** Total tool calls executed this turn (for summary). */
  private toolCallCount = 0;
  /** Agent mode label. */
  private modeLabel: string;
  /**
   * Raw token buffer. Accumulates all streamed tokens for this turn.
   * Used to re-render the full response with markdown styling in finalizeTurn().
   */
  private tokenBuffer = '';

  /**
   * Visible (escape-free) length of the last single-line write.
   * Every transient line is cleared with this exact width — never a constant,
   * which is what let a long line survive its own clear and corrupt the
   * response printed on top of it.
   */
  private lastLineLen = 0;

  /** Phrase currently being shimmered, without spinner or padding. */
  private thinkingPhrase = '';

  /** Position of the shimmer head within {@link thinkingPhrase}. */
  private thinkingHead = 0;

  /** Interval handle for the thinking animation, or null when idle. */
  private thinkingTimer: NodeJS.Timeout | null = null;

  /**
   * Stream chunks received this turn.
   *
   * Named for what it is. It was rendered as "N tokens", which it is not: the
   * provider decides chunk boundaries, so this counts repaints, not billing
   * units. Real token counts arrive through {@link noteTurnSpend}.
   */
  private streamedChunks = 0;

  /** Authoritative per-turn spend, when the caller reports it. */
  private turnSpend: { toolCalls: number; tokens: number; costUsd?: number } | null = null;

  /**
   * Whether stdout is an interactive terminal.
   *
   * When it is not (a pipe, a CI log, a test harness), carriage-return
   * repainting produces garbage instead of animation, so every transient line
   * degrades to a single plain write.
   */
  private readonly isTty: boolean;

  /**
   * @param mode - 'deep' | 'orchestrate' — used for color theming.
   */
  constructor(private readonly mode: 'deep' | 'orchestrate') {
    this.modeLabel = mode === 'deep' ? labels.deep : labels.orchestrator;
    this.isTty = Boolean(process.stdout.isTTY);
  }

  // ── Transient Line Primitives ──────────────────────────────────────────────

  /**
   * Write a single transient line that a later {@link clearLine} can fully erase.
   *
   * The line is truncated to the terminal width so it can never wrap: once a
   * line wraps, `\r` returns to the start of the *last* row only, and every
   * row above it is stranded on screen.
   *
   * @param styled - The line including ANSI escapes.
   * @param visibleLen - Printable character count of `styled`.
   */
  private writeLine(styled: string, visibleLen: number): void {
    // Pad out to the previous width. A frame narrower than the one it replaces
    // would otherwise leave its tail on screen — the elapsed counter shrinking
    // from "990ms" to "1.0s" is enough to strand a character.
    const pad = Math.max(0, this.lastLineLen - visibleLen);
    this.lastLineLen = visibleLen + pad;
    process.stdout.write(`\r${styled}${' '.repeat(pad)}`);
  }

  /**
   * Erase the last transient line and return the cursor to column zero.
   */
  private clearLine(): void {
    if (this.lastLineLen === 0) return;
    process.stdout.write(`\r${' '.repeat(this.lastLineLen)}\r`);
    this.lastLineLen = 0;
  }

  /**
   * Maximum printable width available for a transient line.
   * Leaves two columns of slack so a full-width line never triggers a wrap.
   */
  private get lineWidth(): number {
    return Math.max(20, (process.stdout.columns ?? 80) - 2);
  }

  // ── Shimmer ────────────────────────────────────────────────────────────────

  /**
   * Paint a travelling highlight across `text`.
   *
   * Only the `SHIMMER_TAIL + 1` characters under the head carry an escape
   * sequence; the unlit remainder is emitted as two flat muted runs. Painting
   * per character instead costs ~5× the bytes and ~50× the CPU for pixel-
   * identical output.
   *
   * @param text - The phrase to light up.
   * @param head - Index of the brightest character.
   * @returns The styled phrase.
   */
  private shimmer(text: string, head: number): string {
    const from = Math.max(0, head - SHIMMER_TAIL);
    const to = Math.min(text.length, head + 1);

    // Head is past the end of the phrase — the resting beat between sweeps.
    if (from >= to) return colors.muted(text);

    let out = from > 0 ? colors.muted(text.slice(0, from)) : '';
    for (let i = from; i < to; i++) out += shimmerRamp[head - i](text[i]);
    return to < text.length ? out + colors.muted(text.slice(to)) : out;
  }

  // ── Token Streaming ────────────────────────────────────────────────────────

  /**
   * Buffer a single token and keep the live indicator in sync.
   *
   * Tokens are not printed as they arrive: the response is rendered once, with
   * full markdown styling, in {@link finalizeTurn}. Until then the shimmering
   * "writing" line carries the feedback, with a running token count.
   *
   * It replaces the previous one-dot-per-token stream, which wrote an unbounded
   * line that wrapped on long responses and could no longer be erased.
   *
   * @param token - A partial text chunk from the LLM.
   */
  public streamToken(token: string): void {
    if (!token) return;

    // Print a simple Agent label — no fixed-width box (breaks on narrow terminals)
    if (!this.isStreaming && !this.hasStreamedContent) {
      this.clearThinking();
      process.stdout.write(colors.secondary.bold('  ⬡  Agent') + colors.dim('  ─────────────────────────────') + '\n');
      this.isStreaming = true;
      this.streamedChunks = 0;
      this.showThinking('write');
    }

    // Buffer the raw token for markdown rendering in finalizeTurn()
    this.tokenBuffer += token;
    this.streamedChunks++;
    this.hasStreamedContent = true;
  }

  // ── Tool Call Visualization ────────────────────────────────────────────────

  /**
   * Display the start of a tool call with a live spinner.
   *
   * Prints a bordered box header and begins animating a spinner
   * until {@link showToolEnd} is called.
   *
   * @param toolName - The tool being called (e.g., "safe_read_file").
   * @param input - The raw input object passed to the tool.
   */
  public showToolStart(toolName: string, input: unknown): void {
    // Stop the wait indicator before drawing a box over its line
    this.clearThinking();
    if (this.isStreaming || this.hasStreamedContent) {
      this.isStreaming = false;
    }

    // Clear previous active tool if somehow still running
    if (this.activeTool) this.clearActiveTool();

    const icon = getToolIcon(toolName);
    const inputPreview = formatToolInput(toolName, input);
    const label = `${icon}  ${chalk.white.bold(toolName)}`;
    const inputLine = colors.muted(`${box.arrow} ${inputPreview}`);
    const phrase = getToolPhrase(toolName);

    process.stdout.write('\n');
    process.stdout.write(`${colors.dim(box.topLeft + box.horizontal)} ${label}\n`);
    process.stdout.write(`${colors.dim(box.vertical)}  ${inputLine}\n`);

    const startedAt = Date.now();
    let frame = 0;
    const cycle = phrase.length + SHIMMER_TAIL + SHIMMER_PAUSE;

    const paint = (): void => {
      const spinner = spinnerFrames[Math.floor(frame / 2) % spinnerFrames.length];
      const elapsed = formatDuration(Date.now() - startedAt);
      const styled =
        `${colors.dim(box.vertical)}  ${colors.accent(spinner)}  ` +
        this.shimmer(phrase, frame % cycle) +
        `  ${colors.muted(elapsed)}`;
      // `│` + 2 spaces + spinner + 2 spaces + phrase + 2 spaces + elapsed
      this.writeLine(styled, 8 + phrase.length + elapsed.length);
      frame++;
    };

    let interval: NodeJS.Timeout | null = null;

    if (this.isTty) {
      paint();
      interval = setInterval(paint, SHIMMER_TICK_MS);
      interval.unref?.();
    } else {
      // Non-interactive stdout: state the phrase once, never repaint.
      process.stdout.write(`${box.vertical}  ${phrase}...\n`);
    }

    this.activeTool = { name: toolName, label, phrase, startedAt, frame, interval };
    this.toolCallCount++;
  }

  /**
   * Finalize a tool call: stop the spinner and show completion with elapsed time.
   *
   * @param toolName - The tool that just finished.
   */
  public showToolEnd(toolName: string): void {
    if (!this.activeTool || this.activeTool.name !== toolName) {
      this.clearActiveTool();
      return;
    }

    const { startedAt, interval } = this.activeTool;
    if (interval) clearInterval(interval);

    const elapsed = formatDuration(Date.now() - startedAt);
    const doneIcon = colors.accent('✓');
    const doneLine = `${doneIcon}  ${colors.muted(`done in ${elapsed}`)}`;

    // Erase the spinner line by its real width before closing the box
    this.clearLine();
    process.stdout.write(`${colors.dim(box.bottomLeft + box.horizontal)} ${doneLine}\n`);
    this.activeTool = null;

    // The agent is deciding what to do next — cover the gap
    this.showThinking('think');
  }

  // ── Thinking Indicator ─────────────────────────────────────────────────────

  /**
   * Start the animated wait indicator: a phrase with a light sweeping across it.
   *
   * Idempotent — calling it while already running only swaps the phrase, so the
   * animation never restarts mid-sweep.
   *
   * @param phase - Which wait state to show. Defaults to `'think'`.
   */
  public showThinking(phase: ThinkingPhase = 'think'): void {
    if (this.thinkingTimer) {
      this.setThinkingPhase(phase);
      return;
    }

    this.thinkingPhrase = thinkingPhrases[phase];
    this.thinkingHead = 0;

    // Non-interactive stdout: one plain line, no repainting, no timer.
    if (!this.isTty) {
      process.stdout.write(`\n  ${this.thinkingPhrase}...\n`);
      return;
    }

    process.stdout.write('\n');
    this.renderThinking();
    this.thinkingTimer = setInterval(() => {
      this.thinkingHead =
        (this.thinkingHead + 1) %
        (this.thinkingPhrase.length + SHIMMER_TAIL + SHIMMER_PAUSE);
      this.renderThinking();
    }, SHIMMER_TICK_MS);

    // Never hold the event loop open for an animation.
    this.thinkingTimer.unref?.();
  }

  /**
   * Swap the phrase being shimmered without interrupting the animation.
   *
   * No-op when the indicator is not running, so event handlers can call it
   * unconditionally.
   *
   * @param phase - The wait state to switch to.
   */
  public setThinkingPhase(phase: ThinkingPhase): void {
    const next = thinkingPhrases[phase];
    if (!this.thinkingTimer || this.thinkingPhrase === next) return;

    // A shorter phrase is handled by the padding in writeLine().
    this.thinkingPhrase = next;
    this.thinkingHead = 0;
    this.renderThinking();
  }

  /**
   * Stop the wait indicator and erase its line.
   * Safe to call when nothing is running.
   */
  public clearThinking(): void {
    if (this.thinkingTimer) {
      clearInterval(this.thinkingTimer);
      this.thinkingTimer = null;
    }
    this.thinkingPhrase = '';
    this.thinkingHead = 0;
    if (this.isTty) this.clearLine();
  }

  /**
   * Prints what the finished turn cost, on a line that stays.
   *
   * ## Why the wait indicator was not enough
   *
   * `noteTurnSpend` paints the counter onto the wait indicator, and the wait
   * indicator is transient by contract: it is erased the moment an answer
   * arrives. So the cost of a turn was visible only while the operator was
   * waiting for it, and vanished exactly when they could read it.
   *
   * That went unnoticed while turns were slow. Then the conversation gate and
   * the routing lanes made them fast, and a fast turn barely spins — the
   * cheaper the work became, the more completely its price disappeared. The
   * operator asked where the token counter had gone; it had not gone anywhere,
   * it had never been anywhere durable.
   *
   * @param spend - Tool calls, tokens and USD observed for the turn.
   */
  public showTurnSpend(spend: { toolCalls: number; tokens: number; costUsd?: number }): void {
    if (spend.toolCalls === 0 && spend.tokens === 0) return;

    const parts = [`${spend.toolCalls} call${spend.toolCalls === 1 ? '' : 's'}`];
    if (spend.tokens > 0) parts.push(`${formatTokens(spend.tokens)} tok`);
    // Omitted rather than shown as zero when the model has no published price:
    // a counter reading $0.0000 for a real spend is the failure this started from.
    if (spend.costUsd !== undefined) parts.push(`$${spend.costUsd.toFixed(4)}`);

    process.stdout.write(colors.dim(`  ↳ ${parts.join(' · ')}\n`));
  }

  /**
   * Reports what the current turn has spent, for the live indicator.
   *
   * A recorded turn ran 108 seconds on the word "hey" and another ran 921
   * seconds, with no way to see the cost accumulating. Showing it while it
   * happens is what lets an operator stop a runaway turn instead of reading
   * about it in telemetry afterwards.
   *
   * @param spend - Tool calls, tokens and USD observed so far this turn.
   */
  public noteTurnSpend(spend: { toolCalls: number; tokens: number; costUsd?: number }): void {
    this.turnSpend = spend;
    if (this.thinkingTimer) this.renderThinking();
  }

  /** Clears per-turn spend so the next turn starts from nothing. */
  public resetTurnSpend(): void {
    this.turnSpend = null;
  }

  /**
   * Builds the trailing counter for the wait indicator.
   *
   * @returns The counter text, or an empty string when there is nothing to show.
   * @internal
   */
  private buildCounter(): string {
    const spend = this.turnSpend;
    if (spend && (spend.toolCalls > 0 || spend.tokens > 0)) {
      const parts = [`${spend.toolCalls} calls`, `${formatTokens(spend.tokens)} tok`];
      if (spend.costUsd !== undefined) parts.push(`$${spend.costUsd.toFixed(4)}`);
      return `  ${parts.join(' · ')}`;
    }
    return this.streamedChunks > 0 ? `  ${this.streamedChunks} chunks` : '';
  }

  /**
   * Paint one frame of the wait indicator.
   * @internal
   */
  private renderThinking(): void {
    const frames = spinnerFrames;
    const spinner = frames[Math.floor(this.thinkingHead / 2) % frames.length];
    const counter = this.buildCounter();

    // Reserve room for the spinner, its padding and the counter.
    const budget = this.lineWidth - 5 - counter.length;
    const phrase =
      this.thinkingPhrase.length > budget
        ? `${this.thinkingPhrase.slice(0, Math.max(1, budget - 1))}…`
        : this.thinkingPhrase;

    const styled =
      `  ${colors.dim(spinner)}  ` +
      this.shimmer(phrase, this.thinkingHead) +
      colors.dim(counter);

    this.writeLine(styled, 5 + phrase.length + counter.length);
  }

  // ── Turn Management ────────────────────────────────────────────────────────

  /**
   * Called at the end of each agent turn.
   *
   * Flushes any trailing newline and resets per-turn state.
   */
  public finalizeTurn(): void {
    this.clearActiveTool();
    this.clearThinking();

    // Render the accumulated token buffer with full markdown styling
    if (this.tokenBuffer.trim()) {
      const renderer = new MarkdownRenderer();
      const styled = renderer.render(this.tokenBuffer.trim());
      process.stdout.write('\n' + styled + '\n');

      // Closing separator
      process.stdout.write(colors.dim('  ──────────────────────────────────────') + '\n');
    } else if (this.isStreaming || this.hasStreamedContent) {
      process.stdout.write('\n');
    }

    if (this.toolCallCount > 0) {
      process.stdout.write(colors.dim(`  ┄ ${this.toolCallCount} tool call${this.toolCallCount > 1 ? 's' : ''} executed\n`));
    }

    // Reset state for next turn
    this.isStreaming = false;
    this.hasStreamedContent = false;
    this.toolCallCount = 0;
    this.tokenBuffer = '';
    this.streamedChunks = 0;
  }

  // ── HITL (Human-in-the-Loop) ───────────────────────────────────────────────

  /**
   * Display a HITL approval request to the user.
   *
   * @param toolName - The tool awaiting approval.
   * @param args - The arguments that would be passed to the tool.
   */
  public showHITLRequest(toolName: string, args: unknown): void {
    this.clearThinking();
    const icon = getToolIcon(toolName);
    process.stdout.write('\n');
    process.stdout.write(colors.warning.bold('  ✋  APPROVAL REQUIRED\n'));
    process.stdout.write(colors.dim(`  ${box.arrow} Tool: `) + chalk.white.bold(`${icon} ${toolName}\n`));
    process.stdout.write(colors.dim(`  ${box.arrow} Args: `) + colors.muted(JSON.stringify(args, null, 2).split('\n').join('\n    ')) + '\n');
  }

  // ── Error Display ──────────────────────────────────────────────────────────

  /**
   * Display a formatted error box.
   *
   * @param message - The error message to display.
   * @param detail - Optional additional detail (e.g., stack trace first line).
   */
  public showError(message: string, detail?: string): void {
    this.clearActiveTool();
    this.clearThinking();
    process.stdout.write('\n');
    process.stdout.write(colors.danger.bold('  ✗  Error\n'));
    process.stdout.write(colors.danger(`  ${box.arrow} ${message}\n`));
    if (detail) {
      process.stdout.write(colors.muted(`     ${detail}\n`));
    }
    process.stdout.write('\n');
  }

  // ── Separator ──────────────────────────────────────────────────────────────

  /**
   * Print a visual separator between turns.
   * Keeps the conversation history scannable.
   */
  public showTurnSeparator(): void {
    process.stdout.write('\n' + colors.dim('─'.repeat(50)) + '\n');
  }

  // ── Private Helpers ────────────────────────────────────────────────────────

  /**
   * Safely stop and clear any active tool spinner.
   * @internal
   */
  private clearActiveTool(): void {
    if (this.activeTool) {
      if (this.activeTool.interval) clearInterval(this.activeTool.interval);
      this.activeTool = null;
    }
  }
}
