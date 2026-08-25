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
import { showModelMenu } from './model-menu';
import { ContextCompressor } from '../../core/agent/context-compressor';
import { resolveSummarizerModel } from '../../core/config/model-resolver';
import {
  classifyOrchestrationTask,
  formatOrchestrationRoute,
} from '../../core/agent/task-classifier';
import { shouldRetryEmptyTurn } from './empty-turn-retry';
import { shouldRecoverToolCycle } from './tool-cycle-recovery';
import { TurnAudit, type TurnTraceMetadata } from './turn-audit';

/** Configuration for a ChatSession. */
export interface ChatSessionConfig {
  /** 'deep' | 'orchestrate' — affects theming and model choice. */
  mode: 'deep' | 'orchestrate';
  /** Resolved model string (for display in banner). */
  model: string;
  /** LangGraph thread ID for conversation persistence. */
  threadId: string;
  /**
   * Human-readable session name shown in the banner.
   * If undefined, displays "new session" in the banner.
   * @example "auth-module", "default", "users-refactor"
   */
  sessionName?: string;
  /** LangGraph recursion limit. @default 100 */
  recursionLimit?: number;
  /**
   * Absolute path to the `.env` file for model persistence.
   * When the user uses `/model`, the new AGENT_MODEL is saved here.
   * @default process.cwd() + "/.env"
   */
  envFilePath?: string;
  /**
   * Factory function to recreate the agent with a different model.
   * Required for the `/model` restart feature.
   * Called with the new model string after the user selects it.
   */
  agentFactory?: (newModel: string) => Promise<any>;
  /** Clears only this named session when a completed tool cycle corrupts it. */
  sessionRecovery?: () => Promise<boolean>;
  /** Root used for local, privacy-safe performance records. @default process.cwd() */
  auditRootDir?: string;
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
  private readonly config: {
    mode: 'deep' | 'orchestrate';
    model: string;
    threadId: string;
    sessionName?: string;
    recursionLimit: number;
    envFilePath?: string;
    agentFactory?: (newModel: string) => Promise<any>;
    sessionRecovery?: () => Promise<boolean>;
    auditRootDir: string;
  };
  private readonly graphConfig: { configurable: { thread_id: string }; recursionLimit: number };
  private isRunning = false;
  /** Currently active model string — updated when the user uses /model. */
  private currentModel: string;
  /** Whether deep mentor mode is active for this session. */
  private mentorModeActive = false;
  /**
   * Message count at the time of the last proactive compression.
   * Used as an anti-thrash guard: compression only fires again after
   * at least MIN_MESSAGES_BETWEEN_COMPRESSIONS new messages have been added
   * since the last compression (ADR-024).
   */
  private lastCompressedMessageCount = 0;

  /**
   * @param agent - A compiled LangGraph agent (from createDeepAgent).
   * @param renderer - The StreamRenderer for terminal output.
   * @param config - Session configuration.
   */
  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private agent: any,
    private readonly renderer: StreamRenderer,
    config: ChatSessionConfig,
  ) {
    this.config = {
      recursionLimit: 100,
      auditRootDir: process.cwd(),
      ...config,
    };
    this.currentModel = config.model;
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
   * `umbra deep "create a module"` — sends the first message
   * then keeps the session alive.
   *
   * @param firstMessage - Optional first prompt to send automatically.
   */
  public async start(firstMessage?: string): Promise<void> {
    this.isRunning = true;

    // Welcome banner
    process.stdout.write(buildWelcomeBanner(this.config.mode, this.config.model, this.config.sessionName));

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
  private async sendMessage(input: string, retryCount = 0): Promise<void> {
    this.renderer.showThinking();
    const audit = new TurnAudit({
      rootDir: this.config.auditRootDir,
      mode: this.config.mode,
      model: this.currentModel,
      threadId: this.config.threadId,
      recursionLimit: this.config.recursionLimit,
    });
    let thinkingCleared = false;
    let hasTextOutput = false;
    let hasToolActivity = false;
    const routedInput = this.config.mode === 'orchestrate'
      ? formatOrchestrationRoute(classifyOrchestrationTask(input), input)
      : input;

    try {
      // LangGraph streaming: streamEvents gives us fine-grained events
      const eventStream = this.agent.streamEvents(
        { messages: [{ role: 'human', content: routedInput }] },
        this.createStreamConfig(audit.getTraceMetadata()),
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
            if (token) {
              hasTextOutput = true;
              audit.markTextOutput();
              this.renderer.streamToken(token);
            }
            break;
          }

          // ── Tool call started ────────────────────────────────────────────
          case 'on_tool_start': {
            hasToolActivity = true;
            const toolName = event.name ?? 'unknown';
            const toolInput = event.data?.input ?? {};
            toolStartTimes.set(toolName, Date.now());
            audit.recordToolStart(toolName);
            this.renderer.showToolStart(toolName, toolInput);
            break;
          }

          // ── Tool call finished ───────────────────────────────────────────
          case 'on_tool_end': {
            const toolName = event.name ?? 'unknown';
            this.renderer.showToolEnd(toolName);
            toolStartTimes.delete(toolName);
            audit.recordToolEnd(toolName);
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

      if (shouldRetryEmptyTurn({ hasTextOutput, hasToolActivity, retryCount })) {
        audit.record('empty_response_retry');
        this.renderer.clearThinking();
        this.renderer.finalizeTurn();
        this.renderer.showTurnSeparator();
        process.stdout.write(
          `\n  ⚠️  ${this.colorMuted('Empty response — retrying once...')}\n`,
        );
        return this.sendMessage(input, retryCount + 1);
      }
    } catch (err: unknown) {
      const error = err as Error;

      if (!thinkingCleared) {
        this.renderer.clearThinking();
      }

      if (await this.recoverToolCycle(error, hasToolActivity)) {
        audit.record('provider_400_recovered', error.message);
        this.renderer.finalizeTurn();
        this.renderer.showTurnSeparator();
        return;
      }

      // ── Bug Fix: empty model output retry ──────────────────────────────
      // Gemini (flash-lite) occasionally returns a completely empty response
      // when the session context grows large (many tool calls + long history).
      // deepagents surfaces this as 'model output must contain either output
      // text or tool calls'. We auto-retry with a lightweight context-reset
      // message that gives the model a shorter target to respond to.
      if (
        error?.message?.includes('model output must contain') &&
        retryCount < 1
      ) {
        audit.record('empty_model_retry', error.message);
        process.stdout.write(
          `\n  ⚠️  ${this.colorMuted(`Context overflow — auto-retry ${retryCount + 1}/1...`)}\n`,
        );
        // Small delay to avoid hammering the API
        await new Promise((r) => setTimeout(r, 800));
        return this.sendMessage(
          'Please briefly summarize what you have done so far, then continue with the next pending step.',
          retryCount + 1,
        );
      }

      this.renderer.showError(
        error?.message ?? 'Unknown error',
        error?.stack?.split('\n')[1]?.trim(),
      );
      audit.record(
        error.message.includes('Recursion limit') ? 'recursion_limit' : 'error',
        error.message,
      );
      this.renderer.finalizeTurn();
      this.renderer.showTurnSeparator();
      return;
    }

    audit.record('completed');
    this.renderer.finalizeTurn();
    this.renderer.showTurnSeparator();
  }

  /** Builds a LangChain config carrying trace-safe, per-turn audit metadata. */
  private createStreamConfig(metadata: TurnTraceMetadata): {
    configurable: { thread_id: string };
    recursionLimit: number;
    version: 'v2';
    metadata: TurnTraceMetadata;
    tags: string[];
  } {
    return {
      ...this.graphConfig,
      version: 'v2',
      metadata,
      tags: [`agent:${this.config.mode}`, 'telemetry:interactive-turn'],
    };
  }

  /**
   * Minimal chalk muted color helper — avoids importing theme just for this.
   * @param text - Text to dim.
   */
  private colorMuted(text: string): string {
    return chalk.dim(text);
  }

  /**
   * Repairs a named session after Vertex rejects the response that follows a
   * completed tool call. The original task is not replayed because tools may
   * have already changed external state.
   *
   * @param error - Provider error from the current streamed turn.
   * @param hasToolActivity - Whether a tool finished before the error.
   * @returns Whether a scoped session recovery completed.
   */
  private async recoverToolCycle(error: Error, hasToolActivity: boolean): Promise<boolean> {
    if (!shouldRecoverToolCycle({
      errorMessage: error.message,
      hasToolActivity,
      canRecoverSession: Boolean(this.config.sessionRecovery && this.config.agentFactory),
    })) {
      return false;
    }

    const reset = await this.config.sessionRecovery?.();
    if (!reset) {
      return false;
    }

    try {
      this.agent = await this.config.agentFactory!(this.currentModel);
      process.stdout.write(
        colors.warning(
          '\n  ⚠️  The provider rejected a completed tool cycle. ' +
          'This session was safely reset and is ready for your next instruction.\n',
        ),
      );
      return true;
    } catch {
      return false;
    }
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
        // Use the same extraction logic as sendMessage() to handle Gemini
        // array-of-parts format (chunk.content can be string or [{text:'...'}])
        const chunk = event.data?.chunk;
        const token = typeof chunk?.content === 'string'
          ? chunk.content
          : (chunk?.content?.[0]?.text ?? '');
        if (token) this.renderer.streamToken(token);
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
   *
   * ## Slash Commands
   * - `/model` — opens the interactive model selection menu
   * - `/help`  — shows available slash commands
   */
  private async promptLoop(): Promise<void> {
    while (this.isRunning) {
      const input = await this.readLine();

      if (input === null || !this.isRunning) break;

      const trimmed = input.trim();
      if (!trimmed) continue;

      // ── Slash command dispatcher ────────────────────────────────────────────────────────
      if (trimmed === '/model') {
        await this.handleModelSwitch();
        continue;
      }

      if (trimmed === '/mentor') {
        await this.handleMentorToggle();
        continue;
      }

      if (trimmed === '/help') {
        this.showHelp();
        continue;
      }

      await this.sendMessage(trimmed);
      // Phase 2: proactive compression — check token budget after each turn.
      // Fires silently after the agent's response is fully streamed (ADR-024).
      await this.checkAndCompressContext();
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

  // ── Private: Auto-Compression ──────────────────────────────────────────────

  /**
   * Proactively checks the context token budget after each turn and silently
   * compresses conversation history if the budget is exceeded (ADR-024).
   *
   * ## How it works
   * 1. Reads the current LangGraph state via `getState()` (ADR-021 try/catch).
   * 2. Calls `ContextCompressor.isOverBudget()` (chars / 4 heuristic, 80k default).
   * 3. If over budget AND enough new messages since last compression:
   *    → compresses history and injects a silent `[CONTEXT HANDOFF]` message.
   *
   * ## Anti-thrash guard
   * Tracks `lastCompressedMessageCount`. Compression only fires again after at
   * least `MIN_MESSAGES_BETWEEN_COMPRESSIONS` new messages have been added,
   * preventing repeated compression on every turn when hovering at the threshold.
   *
   * ## Graceful degradation
   * If `getState()` is unavailable (deepagents version mismatch) or compression
   * fails, the error is silently swallowed — the session must continue regardless.
   */
  private async checkAndCompressContext(): Promise<void> {
    /** Minimum new messages since last compression before we compress again. */
    const MIN_MESSAGES_BETWEEN_COMPRESSIONS = 10;

    try {
      const state = await this.agent.getState(this.graphConfig);
      const messages: unknown[] = state?.values?.messages ?? [];

      // Anti-thrash: skip if not enough new messages since last compression
      const newMessagesSinceLastCompression = messages.length - this.lastCompressedMessageCount;
      if (newMessagesSinceLastCompression < MIN_MESSAGES_BETWEEN_COMPRESSIONS) return;

      if (!ContextCompressor.isOverBudget(messages)) return;

      // Over budget — compress silently
      const summarizerModel = resolveSummarizerModel();
      const summary = await ContextCompressor.compress(messages, summarizerModel);

      if (summary) {
        this.lastCompressedMessageCount = messages.length;
        // Inject the summary as a context handoff — no user-visible console output
        await this.sendMessage(
          `[CONTEXT HANDOFF — AUTO COMPRESSION]\n\n` +
          `The conversation history has grown large and was silently compressed.\n` +
          `The following is a technical summary of all work done so far:\n\n` +
          `${summary}\n\n` +
          `Acknowledge this context briefly, then wait for the next instruction.`,
        );
      }
    } catch {
      // ADR-021: getState() or compression may not be available in all contexts.
      // Silently degrade — the session must continue regardless.
    }
  }

  /**
   * Handles the `/model` slash command.
   *
   * Full flow:
   * 1. Opens the interactive model selection menu.
   * 2. If a new model is selected, reads the current LangGraph conversation state.
   * 3. If there is meaningful history (≥3 messages), compresses it with `ContextCompressor`.
   * 4. Calls `agentFactory(newModel)` to rebuild the agent with the new model (hot-swap).
   * 5. If a summary was produced, injects it as the first message in the new agent's context.
   * 6. Shows the welcome banner with the new model.
   *
   * Compression is best-effort (ADR-020): if it fails, the switch still completes.
   * `getState()` is also wrapped in its own try/catch (ADR-021): if deepagents
   * does not expose it or its structure changes, we degrade gracefully.
   *
   * If no `agentFactory` is provided in config, shows a warning and tells
   * the user to restart manually.
   */
  private async handleModelSwitch(): Promise<void> {
    const result = await showModelMenu(
      this.currentModel,
      this.config.envFilePath,
    );

    if (!result) return; // User cancelled

    if (result.model === this.currentModel) {
      console.log(colors.muted('  Already using ' + result.model + '.\n'));
      return;
    }

    if (!this.config.agentFactory) {
      // No factory provided — can't hot-swap. Tell user to restart.
      console.log(colors.warning(
        `  ⚠️  Restart Umbra to apply: umbra deep (AGENT_MODEL is now ${result.model})\n`,
      ));
      return;
    }

    try {
      // ── Step 1: Read current conversation history ─────────────────────────
      let contextSummary: string | null = null;
      try {
        const state = await this.agent.getState(this.graphConfig);
        const messages: unknown[] = state?.values?.messages ?? [];

        if (messages.length >= 3) {
          const summarizerModel = resolveSummarizerModel();
          process.stdout.write(
            colors.muted(`\n  ⏳ Compressing context with ${summarizerModel}...\n`),
          );
          contextSummary = await ContextCompressor.compress(messages, summarizerModel);
          if (contextSummary) {
            process.stdout.write(colors.accent('  ✅ Context compressed.\n\n'));
          } else {
            process.stdout.write(
              colors.muted('  ℹ️  Compression skipped — new model will start fresh.\n\n'),
            );
          }
        }
      } catch {
        // ADR-021: getState() may not be available in all deepagents versions.
        // Degrade gracefully — the model switch must still complete.
        process.stdout.write(
          colors.muted('  ℹ️  Context read unavailable — new model will start fresh.\n\n'),
        );
      }

      // ── Step 2: Hot-swap the agent ────────────────────────────────────────
      // Sync process.env so resolveModel() inside agentFactory picks up the
      // new model. Without this, resolveModel() would return the STARTUP value
      // of AGENT_MODEL (env vars are read once at boot — dotenv doesn't re-read
      // the file). The .env file on disk was already updated by showModelMenu().
      process.env.AGENT_MODEL = result.model;
      const newAgent = await this.config.agentFactory(result.model);
      this.agent = newAgent;
      this.currentModel = result.model;

      // ── Step 3: Inject context summary as first message ───────────────────
      if (contextSummary) {
        await this.sendMessage(
          `[CONTEXT HANDOFF]\n\n` +
          `You have been switched to model: ${result.model}.\n` +
          `The following is a summary of the conversation so far:\n\n` +
          `${contextSummary}\n\n` +
          `Acknowledge this context briefly, then wait for the next instruction.`,
        );
      }

      // ── Step 4: Show the updated welcome banner ───────────────────────────
      process.stdout.write(
        buildWelcomeBanner(this.config.mode, result.model, this.config.sessionName),
      );
    } catch (err: unknown) {
      const message = (err as Error)?.message ?? String(err);
      console.log(colors.danger(`  ✗ Failed to switch model: ${message}\n`));
    }
  }

  /**
   * Handles the `/mentor` slash command.
   *
   * Toggles deep mentor mode on or off for the current session.
   *
   * When activated:
   * - Sends an activation message to the agent so it gets stored in the
   *   SQLite checkpoint history (persists for the rest of the session).
   * - The agent loads `skills/mentor-mode.md` and applies the Forced Output
   *   Contract: root cause + rationale + trade-off on every response.
   *
   * When deactivated:
   * - Sends a deactivation message to the agent.
   * - The lightweight always-on mentor in the base prompt still applies.
   */
  private async handleMentorToggle(): Promise<void> {
    this.mentorModeActive = !this.mentorModeActive;

    if (this.mentorModeActive) {
      process.stdout.write(
        '\n' + colors.accent.bold('  🎓 Mentor Mode ON') +
        colors.muted(' — deep explanations, trade-offs, Socratic gates activated\n\n'),
      );
      // Activation message persisted in SQLite so the agent remembers this for the session
      await this.sendMessage(
        'MENTOR MODE ACTIVATED. Load skills/mentor-mode.md and apply it to all responses ' +
        'for the rest of this session. Confirm activation with a brief acknowledgment.',
      );
    } else {
      process.stdout.write(
        '\n' + colors.muted('  Mentor Mode OFF — returned to standard mode\n\n'),
      );
      await this.sendMessage(
        'MENTOR MODE DEACTIVATED. Return to standard mode. The lightweight mentor ' +
        'in the base prompt (root cause + trade-off format) still applies.',
      );
    }
  }

  /**
   * Displays the list of available slash commands.
   */
  private showHelp(): void {
    const mentorStatus = this.mentorModeActive
      ? colors.accent.bold(' [ON]')
      : colors.muted(' [OFF]');
    console.log('');
    console.log(colors.secondary.bold('  Available slash commands:'));
    console.log(`  ${colors.primary.bold('/model')}   — Switch the active LLM model (Ollama / Vertex AI)`);
    console.log(`  ${colors.primary.bold('/mentor')}${mentorStatus}  — Toggle deep mentor mode (trade-offs, root causes, Socratic gates)`);
    console.log(`  ${colors.primary.bold('/help')}    — Show this help message`);
    console.log(`  ${colors.muted('Ctrl+C')}   — Exit the session`);
    console.log('');
  }
}
