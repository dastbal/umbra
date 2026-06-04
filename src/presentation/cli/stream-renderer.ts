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
  labels,
} from './theme';
import { MarkdownRenderer } from './markdown-renderer';

/** Internal state for a tool call currently in progress. */
interface ActiveTool {
  /** Tool name */
  name: string;
  /** Display string (icon + name) */
  label: string;
  /** Timestamp when the tool call started */
  startedAt: number;
  /** Current spinner frame index */
  frame: number;
  /** Interval handle for spinner animation */
  interval: NodeJS.Timeout;
}

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
   * @param mode - 'deep' | 'orchestrate' — used for color theming.
   */
  constructor(private readonly mode: 'deep' | 'orchestrate') {
    this.modeLabel = mode === 'deep' ? labels.deep : labels.orchestrator;
  }

  // ── Token Streaming ────────────────────────────────────────────────────────

  /**
   * Stream a single token to stdout immediately.
   *
   * Handles the agent response prefix ("Agent: ") on the first token.
   * Subsequent tokens are printed inline without a newline.
   *
   * @param token - A partial text chunk from the LLM.
   */
  public streamToken(token: string): void {
    if (!token) return;

    // Print "Agent: " prefix before the first token
    if (!this.isStreaming && !this.hasStreamedContent) {
      process.stdout.write('\n' + colors.secondary.bold('Agent: ') + '\n');
      this.isStreaming = true;
    }

    // Buffer the raw token for markdown rendering in finalizeTurn()
    this.tokenBuffer += token;

    // Stream a muted placeholder dot per token for real-time feedback.
    // The full styled response is printed after all tokens arrive.
    process.stdout.write(colors.dim('.'));
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
    // Finalize any ongoing token stream before showing a tool box
    if (this.isStreaming || this.hasStreamedContent) {
      process.stdout.write('\n');
      this.isStreaming = false;
    }

    // Clear previous active tool if somehow still running
    if (this.activeTool) this.clearActiveTool();

    const icon = getToolIcon(toolName);
    const inputPreview = formatToolInput(toolName, input);
    const label = `${icon}  ${chalk.white.bold(toolName)}`;
    const inputLine = colors.muted(`${box.arrow} ${inputPreview}`);

    process.stdout.write('\n');
    process.stdout.write(`${colors.dim(box.topLeft + box.horizontal)} ${label}\n`);
    process.stdout.write(`${colors.dim(box.vertical)}  ${inputLine}\n`);

    const startedAt = Date.now();
    let frame = 0;

    const interval = setInterval(() => {
      const spinner = colors.accent(spinnerFrames[frame % spinnerFrames.length]);
      const elapsed = formatDuration(Date.now() - startedAt);
      const line = `${colors.dim(box.vertical)}  ${spinner}  ${colors.muted(elapsed)}`;
      // Overwrite the previous spinner line
      process.stdout.write(`\r${line}  `);
      frame++;
    }, 80);

    this.activeTool = { name: toolName, label, startedAt, frame, interval };
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
    clearInterval(interval);

    const elapsed = formatDuration(Date.now() - startedAt);
    const doneIcon = colors.accent('✓');
    const doneLine = `${doneIcon}  ${colors.muted(`done in ${elapsed}`)}`;

    process.stdout.write(`\r${colors.dim(box.bottomLeft + box.horizontal)} ${doneLine}                    \n`);
    this.activeTool = null;
  }

  // ── Thinking Indicator ─────────────────────────────────────────────────────

  /**
   * Show a "thinking" line before the agent starts reasoning.
   * Called at the beginning of each turn before any tokens arrive.
   */
  public showThinking(): void {
    process.stdout.write(colors.muted('\n  ⠋  Thinking...\r'));
  }

  /**
   * Clear the "thinking" line. Called when the first token or tool arrives.
   */
  public clearThinking(): void {
    process.stdout.write('                           \r');
  }

  // ── Turn Management ────────────────────────────────────────────────────────

  /**
   * Called at the end of each agent turn.
   *
   * Flushes any trailing newline and resets per-turn state.
   */
  public finalizeTurn(): void {
    this.clearActiveTool();

    // Render the accumulated token buffer with full markdown styling
    if (this.tokenBuffer.trim()) {
      // Clear the streaming dots line
      process.stdout.write('\r' + ' '.repeat(80) + '\r');

      const renderer = new MarkdownRenderer();
      const styled = renderer.render(this.tokenBuffer.trim());
      process.stdout.write('\n' + styled + '\n');
    } else if (this.isStreaming || this.hasStreamedContent) {
      process.stdout.write('\n');
    }

    if (this.toolCallCount > 0) {
      process.stdout.write(colors.dim(`\n  ${this.toolCallCount} tool call${this.toolCallCount > 1 ? 's' : ''} executed\n`));
    }

    // Reset state for next turn
    this.isStreaming = false;
    this.hasStreamedContent = false;
    this.toolCallCount = 0;
    this.tokenBuffer = '';
  }

  // ── HITL (Human-in-the-Loop) ───────────────────────────────────────────────

  /**
   * Display a HITL approval request to the user.
   *
   * @param toolName - The tool awaiting approval.
   * @param args - The arguments that would be passed to the tool.
   */
  public showHITLRequest(toolName: string, args: unknown): void {
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
      clearInterval(this.activeTool.interval);
      this.activeTool = null;
    }
  }
}
