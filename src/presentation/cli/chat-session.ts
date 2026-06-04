/**
 * @module ChatSession
 *
 * Interactive streaming chat session for the nestjs-ai-agent-lib CLI.
 *
 * Manages the full conversation loop:
 * 1. Prints the welcome banner
 * 2. Shows a "You:" prompt (just like Claude/Gemini CLI)
 * 3. Sends the user's message to the agent via streamEvents()
 * 4. Feeds each event to StreamRenderer for real-time display
 * 5. Handles HITL interrupts (approval flow)
 * 6. Loops back to step 2 (session stays open)
 *
 * @example
 * ```ts
 * const session = new ChatSession(agent, renderer, {
 *   mode: 'deep',
 *   model: 'gemini-2.5-flash-lite',
 *   threadId: 'cli-session',
 * });
 * await session.start('create a UsersModule'); // first message optional
 * ```
 */

import * as readline from 'readline';
import chalk from 'chalk';
import { Command as LangGraphCommand } from '@langchain/langgraph';
import { StreamRenderer } from './stream-renderer';
import { colors, buildWelcomeBanner } from './theme';

/** Configuration for a ChatSession. */
export interface ChatSessionConfig {
  /** 'deep' | 'orchestrate' — affects theming and model choice. */
  mode: 'deep' | 'orchestrate';
  /** Resolved model string (for display in banner). */
  model: string;
  /** LangGraph thread ID for conversation persistence. */
  threadId: string;
  /** LangGraph recursion limit. @default 100 */
  recursionLimit?: number;
}

/**
 * ChatSession — Interactive streaming conversation loop.
 *
 * Keeps the terminal session alive between prompts, exactly like
 * the Claude CLI or Gemini CLI experience.
 *
 * Architecture decision — readline lifecycle:
 * We do NOT keep a single readline instance open for the whole session.
 * Keeping readline open while streaming causes it to print phantom `>`
 * prompts that corrupt the streaming output (stdout collision).
 * Instead, we create a short-lived readline ONLY for each user prompt,
 * and close it immediately after the user presses Enter. This guarantees
 * readline is never alive while tokens are being streamed.
 */
export class ChatSession {
  private readonly config: Required<ChatSessionConfig>;
  private readonly graphConfig: { configurable: { thread_id: string }; recursionLimit: number };
  private isRunning = false;

  /**
   * @param agent - A compiled LangGraph agent (from createDeepAgent).
   * @param renderer - The StreamRenderer for terminal output.
   * @param config - Session configuration.
   */
  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly agent: any,
    private readonly renderer: StreamRenderer,
    config: ChatSessionConfig,
  ) {
    this.config = {
      recursionLimit: 100,
      ...config,
    };
    this.graphConfig = {
      configurable: { thread_id: this.config.threadId },
      recursionLimit: this.config.recursionLimit,
    };
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Start the interactive session.
   *
   * If `firstMessage` is provided, it is sent immediately before dropping
   * into the interactive loop. This supports the CLI pattern:
   * `npm run agent -- deep "create a module"` — sends the first message
   * then keeps the session alive.
   *
   * @param firstMessage - Optional first prompt to send automatically.
   */
  public async start(firstMessage?: string): Promise<void> {
    this.isRunning = true;

    // Welcome banner
    process.stdout.write(buildWelcomeBanner(this.config.mode, this.config.model));

    // Handle Ctrl+C gracefully (no readline needed — process-level signal)
    process.on('SIGINT', () => this.shutdown());

    // Send first message if provided (from CLI argument)
    if (firstMessage?.trim()) {
      await this.sendMessage(firstMessage.trim());
    }

    // Enter interactive loop
    await this.promptLoop();
  }

  // ── Private: Message Sending ───────────────────────────────────────────────

  /**
   * Send a single message to the agent and stream the response.
   *
   * Handles the full lifecycle:
   * 1. Show thinking indicator
   * 2. Iterate streamEvents
   * 3. Route each event to the renderer
   * 4. Handle HITL if the agent is interrupted
   * 5. Finalize the turn
   *
   * @param input - The user's message text.
   */
  private async sendMessage(input: string): Promise<void> {
    this.renderer.showThinking();
    let thinkingCleared = false;

    try {
      // LangGraph streaming: streamEvents gives us fine-grained events
      const eventStream = this.agent.streamEvents(
        { messages: [{ role: 'human', content: input }] },
        { ...this.graphConfig, version: 'v2' },
      );

      // Track active tool name for pairing start/end events
      const toolStartTimes = new Map<string, number>();

      for await (const event of eventStream) {
        // Clear "Thinking..." on first real event
        if (!thinkingCleared) {
          this.renderer.clearThinking();
          thinkingCleared = true;
        }

        switch (event.event) {
          // ── Token streaming ──────────────────────────────────────────────
          case 'on_chat_model_stream': {
            const chunk = event.data?.chunk;
            const token = typeof chunk?.content === 'string'
              ? chunk.content
              : (chunk?.content?.[0]?.text ?? '');
            if (token) this.renderer.streamToken(token);
            break;
          }

          // ── Tool call started ────────────────────────────────────────────
          case 'on_tool_start': {
            const toolName = event.name ?? 'unknown';
            const toolInput = event.data?.input ?? {};
            toolStartTimes.set(toolName, Date.now());
            this.renderer.showToolStart(toolName, toolInput);
            break;
          }

          // ── Tool call finished ───────────────────────────────────────────
          case 'on_tool_end': {
            const toolName = event.name ?? 'unknown';
            this.renderer.showToolEnd(toolName);
            toolStartTimes.delete(toolName);
            break;
          }

          // ── Agent interrupted (HITL) ─────────────────────────────────────
          case 'on_chain_end': {
            const output = event.data?.output;
            if (output?.__interrupt__) {
              await this.handleHITL(output.__interrupt__);
            }
            break;
          }
        }
      }
    } catch (err: unknown) {
      const error = err as Error;

      if (!thinkingCleared) {
        this.renderer.clearThinking();
      }

      this.renderer.showError(
        error?.message ?? 'Unknown error',
        error?.stack?.split('\n')[1]?.trim(),
      );
    }

    this.renderer.finalizeTurn();
    this.renderer.showTurnSeparator();
  }

  // ── Private: HITL Handler ──────────────────────────────────────────────────

  /**
   * Handle a HITL (Human-in-the-Loop) interrupt from the agent.
   *
   * Displays each pending action request, prompts the user for approval,
   * then resumes the agent with the collected decisions.
   *
   * @param interrupts - The interrupt payload from LangGraph.
   */
  private async handleHITL(interrupts: unknown[]): Promise<void> {
    const interrupt = (interrupts as any[])[0]?.value;
    if (!interrupt) return;

    const actionRequests: any[] = interrupt.actionRequests ?? [];
    const reviewConfigs: any[]  = interrupt.reviewConfigs ?? [];
    const decisions: any[] = [];

    for (let i = 0; i < actionRequests.length; i++) {
      const action = actionRequests[i];
      this.renderer.showHITLRequest(action.name, action.args);

      const allowed: string[] = reviewConfigs[i]?.allowedDecisions ?? ['approve', 'reject'];
      const approved = await this.askApproval(`  Approve? [${allowed.join('/')}] `);

      if (approved) {
        process.stdout.write(colors.accent('  ✓ Approved\n'));
        decisions.push({ type: 'approve' });
      } else {
        process.stdout.write(colors.danger('  ✗ Rejected\n'));
        decisions.push({
          type: 'reject',
          message: 'User rejected this action. Do not retry. Ask the user what to do next.',
        });
      }
    }

    // Resume the agent with decisions (streaming continues from resumed state)
    const resumeStream = this.agent.streamEvents(
      new LangGraphCommand({ resume: { decisions } }),
      { ...this.graphConfig, version: 'v2' },
    );

    for await (const event of resumeStream) {
      if (event.event === 'on_chat_model_stream') {
        const token = event.data?.chunk?.content ?? '';
        if (typeof token === 'string' && token) this.renderer.streamToken(token);
      } else if (event.event === 'on_tool_start') {
        this.renderer.showToolStart(event.name, event.data?.input ?? {});
      } else if (event.event === 'on_tool_end') {
        this.renderer.showToolEnd(event.name);
      }
    }
  }

  // ── Private: Interactive Loop ──────────────────────────────────────────────

  /**
   * Main interactive prompt loop.
   *
   * Shows "You: " prompt, waits for user input, sends it, repeats.
   * Exits cleanly on empty input or Ctrl+C.
   */
  private async promptLoop(): Promise<void> {
    while (this.isRunning) {
      const input = await this.readLine();

      if (input === null || !this.isRunning) break;
      if (!input.trim()) continue;

      await this.sendMessage(input.trim());
    }
  }

  /**
   * Prompt the user and wait for a line of input.
   *
   * Creates a fresh readline for each question and closes it immediately
   * after the user presses Enter. This prevents readline from staying open
   * while the agent streams tokens (which caused phantom `>` prompts).
   *
   * @returns The input string, or null if the session was closed.
   */
  private readLine(): Promise<string | null> {
    return new Promise((resolve) => {
      if (!this.isRunning) { resolve(null); return; }

      // Short-lived readline — only alive while waiting for input
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      rl.on('SIGINT', () => {
        rl.close();
        this.shutdown();
      });

      rl.question(
        '\n' + colors.primary.bold('You: ') + chalk.white(''),
        (answer) => {
          rl.close(); // ← closed before streaming starts
          resolve(answer);
        },
      );
    });
  }

  /**
   * Prompt for a y/n approval decision.
   * Also uses a short-lived readline to avoid streaming interference.
   *
   * @param prompt - The question to display.
   * @returns True if approved.
   */
  private askApproval(prompt: string): Promise<boolean> {
    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      rl.question(colors.warning(prompt), (answer) => {
        rl.close();
        resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'approve');
      });
    });
  }

  /**
   * Cleanly shut down the session.
   */
  private shutdown(): void {
    this.isRunning = false;
    process.stdout.write('\n' + colors.muted('  Session ended. Goodbye!\n\n'));
    process.exit(0);
  }
}
