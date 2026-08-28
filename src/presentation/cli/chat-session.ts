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

import chalk from 'chalk';
import { Command as LangGraphCommand } from '@langchain/langgraph';
import { StreamRenderer } from './stream-renderer';
import { colors, buildWelcomeBanner } from './theme';
import { showModelMenu } from './model-menu';
import { isInteractive, selectOutcome, type SelectChoice } from './interactive-select';
import { askText } from './prompts';
import { DELEGATE_QUESTION_KIND } from '../../core/tools/interaction/ask-delegator.tool';
import { readPendingInterrupts, type PendingInterrupt } from './pending-interrupts';

import { recordBudgetProbe } from '../../core/agent/budget-probe';
import {
  type TurnSpend,
  createTurnSpend,
  readUsage,
  recordToolCall,
  recordUsage,
} from '../../core/agent/turn-governor';
import { LlmPricingConfig } from '../../core/infrastructure/config/llm-pricing.config';
import { CostTrackerService } from '../../core/application/services/cost-tracker.service';
import { TokenUsage } from '../../core/domain/value-objects/token-usage';

/**
 * Suspensions answered in one turn before the CLI gives the prompt back.
 *
 * A backstop, not a budget: each round settles a real question the operator
 * asked for. A graph that keeps re-suspending without progressing must return
 * control rather than hold the session.
 */
const MAX_INTERRUPT_ROUNDS = 8;
import { canEditLive, editLine, type Suggestion } from './line-editor';
import {
  buildSlashCommands,
  buildSlashCompleter,
  completeSlashCommand,
  findSlashCommand,
  looksLikeSlashCommand,
  suggestSlashCommands,
  type SlashCommand,
} from './slash-commands';
import { ContextCompressor } from '../../core/agent/context-compressor';
import { resolveSummarizerModel } from '../../core/config/model-resolver';
import {
  resolveConfiguredReasoningLevel,
  resolveReasoningLevel,
} from '../../core/config/reasoning-profile';
import {
  classifyOrchestrationTask,
  classifySmallTalk,
  formatOrchestrationRoute,
  type SmallTalkKind,
} from '../../core/agent/task-classifier';
import { shouldRetryEmptyTurn } from './empty-turn-retry';
import { shouldRecoverToolCycle } from './tool-cycle-recovery';
import { TurnAudit, type TurnTraceMetadata } from './turn-audit';
import { flushPendingTraces } from '../../core/observability';

/**
 * Resolves the reasoning level the given model will actually run at.
 *
 * The configured level may not exist on the model in hand, so the banner
 * reports the clamped value rather than the stored one — what is shown is what
 * the next request will carry.
 *
 * @param model - The model the session is about to use.
 * @returns The active level, or undefined when the model has no reasoning knob.
 */
function activeReasoningLevel(model: string): string | undefined {
  return resolveReasoningLevel(model, resolveConfiguredReasoningLevel());
}

/**
 * Builds the rejection decision sent back to the graph.
 *
 * The message matters as much as the type: without an explicit instruction not
 * to retry, the model reads a bare rejection as a transient failure and calls
 * the same gated tool again (ADR-011).
 *
 * @returns The reject decision payload.
 */
export function rejectionDecision(): { type: string; message: string } {
  return {
    type: 'reject',
    message: 'User rejected this action. Do not retry. Ask the user what to do next.',
  };
}

/**
 * Turns the gate's `allowedDecisions` into menu rows.
 *
 * Built from `allowed` rather than hardcoded, so a decision the policy starts
 * permitting appears in the menu without another change here. `requestApproval`
 * currently emits only `approve` and `reject`; `edit` is part of the payload
 * type and is handled if it ever arrives.
 *
 * Unknown decision types are shown verbatim rather than dropped — silently
 * hiding an option the gate offered would misrepresent the operator's choices.
 *
 * @param allowed - Decision identifiers permitted for this action.
 * @returns Rows for the approval prompt, approve first.
 */
export function buildDecisionChoices(allowed: string[]): SelectChoice<string>[] {
  const known: Record<string, { label: string; hint?: string }> = {
    approve: { label: '✓  Approve',           hint: 'let the action run' },
    reject:  { label: '✗  Reject',            hint: 'block it and tell the agent to stop' },
    edit:    { label: '✎  Change it',         hint: 'send it back with an instruction' },
  };

  const order = ['approve', 'edit', 'reject'];
  const sorted = [...allowed].sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib);
  });

  return sorted.map((decision) => ({
    label: known[decision]?.label ?? decision,
    hint: known[decision]?.hint,
    value: decision,
  }));
}

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
 * Instead, a short-lived readline is created ONLY for each user prompt and
 * closed immediately after the user presses Enter. This guarantees readline is
 * never alive while tokens are being streamed.
 *
 * That lifetime now lives in `./prompts` (`askText`), which every question in
 * this class goes through — so the rule is enforced in one place instead of
 * being re-implemented per prompt. The reasoning above is why it exists.
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
   * The slash command registry for this session.
   *
   * Built once in the constructor and read by the dispatcher, the picker and
   * the help text, so all three can never disagree about what exists.
   */
  /**
   * Prices the running turn for the live indicator.
   *
   * Built once per session rather than per turn: `LlmPricingConfig` reads the
   * project override from disk in its constructor.
   */
  private readonly costTracker = new CostTrackerService(new LlmPricingConfig());

  private readonly slashCommands: SlashCommand[];
  /** Lines the operator submitted this session, for the editor's history. */
  private readonly inputHistory: string[] = [];
  /** Cap on remembered lines, so a long session does not grow the list forever. */
  private static readonly MAX_HISTORY = 100;

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
    this.slashCommands = buildSlashCommands({
      switchModel:       () => this.handleModelSwitch(),
      toggleMentor:      () => this.handleMentorToggle(),
      openCommandPicker: () => this.handleHelp(),
      printHelp:         () => this.showHelp(),
      exitSession:       () => this.shutdown(),
      isMentorActive:    () => this.mentorModeActive,
    });
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
    process.stdout.write(buildWelcomeBanner(
        this.config.mode,
        this.config.model,
        this.config.sessionName,
        activeReasoningLevel(this.config.model),
      ));

    // Handle Ctrl+C gracefully (no readline needed — process-level signal)
    process.on('SIGINT', () => void this.shutdown());

    // Send first message if provided (from CLI argument)
    const first = firstMessage?.trim();
    if (first && !this.handledAsSmallTalk(first)) {
      await this.sendMessage(first);
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
    let hasTextOutput = false;
    let hasToolActivity = false;
    // Display spend for this turn. The middleware keeps its own copy for
    // enforcement; both use the same pure functions, so the two cannot drift in
    // how they read a provider's usage report.
    const spend = createTurnSpend(Date.now());
    this.renderer.resetTurnSpend?.();
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
        // The wait indicator is no longer torn down on the first event: the
        // renderer owns its own transitions (tool box -> writing -> done), so
        // it keeps covering the dead air *between* events instead of only the
        // gap before the first one. It is stopped in finalizeTurn().
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

          // ── Model call finished ──────────────────────────────────────────
          // Token usage is only readable here. The deep path has never consumed
          // it: `usage_metadata` is read solely by the legacy graph nodes that
          // ADR-011 deprecated, which is why a turn's real cost is unknown.
          case 'on_chat_model_end': {
            const observed = readUsage(event.data?.output);
            if (observed) {
              recordUsage(spend, observed);
              this.reportSpend(spend);
            }

            const usage = event.data?.output?.usage_metadata;
            recordBudgetProbe(this.config.auditRootDir, {
              at: 'on_chat_model_end',
              hasUsageMetadata: Boolean(usage),
              usageKeys: usage ? Object.keys(usage) : [],
              ...(usage ? {
                inputTokens: usage.input_tokens,
                outputTokens: usage.output_tokens,
                totalTokens: usage.total_tokens,
              } : {}),
            });
            break;
          }

          // ── Tool call started ────────────────────────────────────────────
          case 'on_tool_start': {
            hasToolActivity = true;
            const toolName = event.name ?? 'unknown';
            const toolInput = event.data?.input ?? {};
            toolStartTimes.set(toolName, Date.now());
            audit.recordToolStart(toolName);
            recordToolCall(spend);
            this.reportSpend(spend);
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

      // The stream never reports a suspension, so ask the graph itself before
      // handing the prompt back. See settlePendingInterrupts.
      await this.settlePendingInterrupts();

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

      this.renderer.clearThinking();

      if (await this.recoverToolCycle(error, hasToolActivity)) {
        // Pass the raw error: it carries the request context the message lost.
        audit.record('provider_400_recovered', error.message, err);
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
        err,
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
  /**
   * Answers every suspension the graph is waiting on before the turn ends.
   *
   * ## Why this exists
   *
   * The stream loop above watches `on_chain_end` for `__interrupt__`, and that
   * key never arrives. Measured on 2026-08-27 against a real suspended graph: a
   * tool that calls `interrupt()` emits `on_tool_start` and then
   * `on_tool_error`, never `on_tool_end`, and the stream finishes normally with
   * no suspension visible on any event — while `getState` reports the graph
   * waiting with one pending interrupt.
   *
   * The operator therefore saw a spinner that never resolved. The run had
   * genuinely stopped to ask a question, and nothing ever asked it. That was
   * the 145-second "hang" of that day, and it applied to **every** `interrupt()`
   * in this CLI, the ADR-011 security approval gate included.
   *
   * State is the authority; the event stream is a view of it that happens to
   * omit exactly this. So the turn now finishes by asking the graph directly.
   *
   * ## Why a loop
   *
   * {@link handleHITL} resumes through the same stream, so a second suspension
   * raised while resuming would be just as invisible. Each round settles one and
   * looks again. The bound is a backstop: a graph that keeps re-suspending
   * without progress must end the turn rather than hold the operator forever.
   */
  private async settlePendingInterrupts(): Promise<void> {
    for (let round = 0; round < MAX_INTERRUPT_ROUNDS; round += 1) {
      const pending = await this.readPendingInterrupts();
      if (pending.length === 0) return;

      this.renderer.clearThinking();
      await this.handleHITL(pending);
    }

    process.stdout.write(
      `\n  ⚠️  ${this.colorMuted('The run kept suspending; ending the turn. Send another instruction to continue.')}\n`,
    );
  }

  /**
   * Reads the graph's pending suspensions, tolerating a graph without state.
   *
   * A mode compiled without a checkpointer has no state to read and no way to
   * suspend either, so an absent `getState` is a normal condition, never an
   * error.
   *
   * @returns The suspensions awaiting an answer, empty when there are none.
   */
  private async readPendingInterrupts(): Promise<PendingInterrupt[]> {
    const getState = (this.agent as { getState?: (config: unknown) => Promise<unknown> }).getState;
    if (typeof getState !== 'function') return [];

    try {
      return readPendingInterrupts(await getState.call(this.agent, this.graphConfig));
    } catch {
      return [];
    }
  }

  private async handleHITL(interrupts: unknown[]): Promise<void> {
    const interrupt = (interrupts as any[])[0]?.value;
    if (!interrupt) return;

    // A question from a delegate is not an approval request. Without this
    // branch it would render as one — see handleDelegateQuestion.
    if (interrupt.kind === DELEGATE_QUESTION_KIND) {
      await this.handleDelegateQuestion(interrupt);
      return;
    }

    const actionRequests: any[] = interrupt.actionRequests ?? [];
    const reviewConfigs: any[]  = interrupt.reviewConfigs ?? [];
    const decisions: any[] = [];

    for (let i = 0; i < actionRequests.length; i++) {
      const action = actionRequests[i];
      this.renderer.showHITLRequest(action.name, action.args);

      const allowed: string[] = reviewConfigs[i]?.allowedDecisions ?? ['approve', 'reject'];
      const decision = await this.askDecision(allowed);

      if (decision.type === 'approve') {
        process.stdout.write(colors.accent('  ✓ Approved\n'));
      } else if (decision.type === 'edit') {
        process.stdout.write(colors.warning('  ✎ Sent back with feedback\n'));
      } else {
        process.stdout.write(colors.danger('  ✗ Rejected\n'));
      }
      decisions.push(decision);
    }

    // Resume the agent with decisions (streaming continues from resumed state)
    await this.resumeAgent({ decisions });
  }

  /**
   * Renders a subagent question and resumes the run with the answer.
   *
   * A question is not an approval, and before this branch existed every
   * interrupt was read as one — `actionRequests` plus `reviewConfigs`. Without
   * the discriminator a delegate asking what "improve the skills" meant would
   * have rendered as an authorization to perform an action, which is a worse
   * outcome than not having the feature.
   *
   * Cancelling is deliberately not an answer. Escape on the security gate means
   * reject; here it means the operator declined to answer, and the delegate is
   * told exactly that so it records an unknown instead of inventing a reply.
   *
   * @param request - The question raised by a delegate.
   */
  private async handleDelegateQuestion(request: {
    question: string;
    options?: string[];
  }): Promise<void> {
    this.renderer.clearThinking();
    process.stdout.write(`\n  ${colors.accent('?')} ${chalk.bold('A subagent is asking:')}\n`);
    process.stdout.write(`  ${request.question}\n\n`);

    const answer = await this.readAnswer(request.options);

    if (answer === undefined) {
      process.stdout.write(colors.muted('  — not answered; the subagent will record it as unknown\n'));
    }

    await this.resumeAgent({ answer });
  }

  /**
   * Collects the operator answer, as a menu when choices were offered.
   *
   * @param options - Choices supplied by the delegate, when it supplied any.
   * @returns The answer, or `undefined` when the operator did not give one.
   */
  private async readAnswer(options?: string[]): Promise<string | undefined> {
    if (options && options.length > 0 && isInteractive()) {
      const outcome = await selectOutcome<string>({
        title: 'Answer',
        choices: options.map((option): SelectChoice<string> => ({ label: option, value: option })),
      });
      return outcome.status === 'selected' ? outcome.value : undefined;
    }

    const typed = await askText({ prompt: '  Your answer (empty to skip): ' });
    const trimmed = typed?.trim();
    return trimmed === undefined || trimmed === '' ? undefined : trimmed;
  }

  /**
   * Resumes a suspended run and keeps rendering its output.
   *
   * Shared by the approval gate and the question channel so both resume through
   * one code path; two copies of a streaming loop is how the two drift apart.
   *
   * @param payload - The value handed back to the waiting `interrupt()`.
   */
  private async resumeAgent(payload: unknown): Promise<void> {
    const resumeStream = this.agent.streamEvents(
      new LangGraphCommand({ resume: payload }),
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
   * Not listed here on purpose: the authoritative list is the registry in
   * `./slash-commands`, and a copy in this comment is a copy that goes stale.
   */
  private async promptLoop(): Promise<void> {
    while (this.isRunning) {
      const input = await this.readLine();

      if (input === null || !this.isRunning) break;

      const trimmed = input.trim();
      if (!trimmed) continue;

      // ── Slash command dispatcher ────────────────────────────────────────────
      // Every command comes from the one registry, so a new entry there is
      // reachable here with no change.
      const command = findSlashCommand(this.slashCommands, trimmed);
      if (command) {
        await command.run();
        continue;
      }

      // A slash-prefixed word that matches nothing is a typo, not a prompt.
      // Sending it to the agent would spend a turn on it and answer nonsense.
      if (looksLikeSlashCommand(trimmed)) {
        this.reportUnknownCommand(trimmed);
        continue;
      }

      if (this.handledAsSmallTalk(trimmed)) continue;

      await this.sendMessage(trimmed);
      // Phase 2: proactive compression — check token budget after each turn.
      // Fires silently after the agent's response is fully streamed (ADR-024).
      await this.checkAndCompressContext();
    }
  }

  /**
   * Prompt the user and wait for a line of input.
   *
   * Delegates to `askText`, which creates a fresh readline per question and
   * closes it before resolving. This prevents readline from staying open while
   * the agent streams tokens (which caused phantom `>` prompts).
   *
   * @returns The input string, or null if the session was closed.
   */
  private async readLine(): Promise<string | null> {
    if (!this.isRunning) return null;

    const styledPrompt = colors.primary.bold('You: ') + chalk.white('');

    if (canEditLive()) {
      // The live editor cannot take a prompt containing a newline — it has to
      // know which column the text starts in — so the blank line is written
      // before it opens rather than being part of the prompt.
      process.stdout.write('\n');
      const line = await editLine({
        prompt: styledPrompt,
        suggest: (typed) => this.suggestForPalette(typed),
        history: this.inputHistory,
        onInterrupt: () => this.shutdown(),
      });
      if (line?.trim()) this.rememberInput(line.trim());
      return line;
    }

    // Fallback: `askText` owns a short-lived readline and closes it before
    // resolving, which is what keeps streaming output clean. Tab still
    // completes here; only the live palette needs the editor above.
    const typed = await askText({
      prompt: '\n' + styledPrompt,
      onInterrupt: () => this.shutdown(),
      completer: buildSlashCompleter(this.slashCommands),
    });
    if (typed?.trim()) this.rememberInput(typed.trim());
    return typed;
  }

  /**
   * Builds the live palette rows for what the operator has typed so far.
   *
   * Reads the same registry as the dispatcher, so the palette is its fifth
   * consumer and still needs no list of its own.
   *
   * Returns nothing unless the text looks like a command being typed. A palette
   * that opened on ordinary prose would cover the screen on every message and
   * make `↑↓` unusable for history.
   *
   * @param typed - The current line.
   * @returns The rows to show beneath the prompt.
   */
  private suggestForPalette(typed: string): Suggestion[] {
    if (!looksLikeSlashCommand(typed)) return [];
    return completeSlashCommand(this.slashCommands, typed).map((command) => ({
      value: command.name,
      label: command.name,
      hint: command.hint?.() ?? command.description,
    }));
  }

  /**
   * Records a submitted line for `↑↓` history.
   *
   * Skips an immediate repeat, because a history full of the same line makes
   * `↑` useless, and caps the list so a long session does not grow it without
   * bound.
   *
   * @param line - The submitted line, already trimmed and non-empty.
   */
  private rememberInput(line: string): void {
    if (this.inputHistory[this.inputHistory.length - 1] === line) return;
    this.inputHistory.push(line);
    if (this.inputHistory.length > ChatSession.MAX_HISTORY) this.inputHistory.shift();
  }

  /**
   * Ask the operator to decide on one pending action (ADR-011).
   *
   * On an interactive terminal this is an arrow-key menu built from the
   * decisions the gate actually allows, so the operator never has to know that
   * `y` means approve. Without a TTY it falls back to {@link askApproval}.
   *
   * ## Why cancelling is a rejection
   *
   * Escape and Ctrl+C both resolve to **reject**, never to approve. This prompt
   * guards a write or a delete that the security policy refused to allow on its
   * own; an ambiguous keystroke must fail closed. Ctrl+C additionally ends the
   * session, matching what it does at the chat prompt — but the rejection is
   * recorded first, so the agent never resumes with an unanswered gate.
   *
   * @param allowed - Decision types the gate permits, from `allowedDecisions`.
   * @returns The decision to send back to the graph.
   */
  private async askDecision(
    allowed: string[],
  ): Promise<{ type: string; message?: string }> {
    if (!isInteractive()) {
      const approved = await this.askApproval(`  Approve? [${allowed.join('/')}] `);
      return approved ? { type: 'approve' } : rejectionDecision();
    }

    const outcome = await selectOutcome<string>({
      title: 'This action needs your approval',
      choices: buildDecisionChoices(allowed),
    });

    if (outcome.status === 'interrupted') {
      // Record the rejection before tearing the session down, so the graph is
      // never left resumed on an unanswered gate.
      process.stdout.write(colors.danger('  ✗ Rejected (interrupted)\n'));
      setImmediate(() => void this.shutdown());
      return rejectionDecision();
    }

    if (outcome.status !== 'selected') return rejectionDecision();

    if (outcome.value === 'edit') {
      const feedback = await this.readFeedback();
      return { type: 'edit', message: feedback };
    }

    return outcome.value === 'approve' ? { type: 'approve' } : rejectionDecision();
  }

  /**
   * Reads a free-text instruction for an `edit` decision.
   *
   * Uses a short-lived readline, for the same reason as {@link readLine}.
   *
   * @returns The operator's text, or a generic instruction if left empty.
   */
  private async readFeedback(): Promise<string> {
    const answer = await askText({
      prompt: colors.warning('  What should it do instead? '),
    });
    return answer?.trim() ||
      'The user wants this action changed. Ask them what to do next.';
  }

  /**
   * Prompt for a y/n approval decision.
   *
   * Retained as the non-interactive path for {@link askDecision}: with piped
   * stdin there are no keystrokes for an arrow menu to read.
   * Also uses a short-lived readline to avoid streaming interference.
   *
   * @param prompt - The question to display.
   * @returns True if approved.
   */
  private async askApproval(prompt: string): Promise<boolean> {
    const answer = await askText({ prompt: colors.warning(prompt) });
    // Anything that is not an explicit yes is a refusal: this guards a write or
    // a delete, so silence and nonsense must both fail closed.
    const normalized = answer?.trim().toLowerCase() ?? '';
    return normalized === 'y' || normalized === 'approve';
  }

  /**
   * Cleanly shut down the session.
   *
   * The farewell is written *before* the trace flush, so the operator sees the
   * session end immediately and the wait — bounded, usually zero — happens
   * behind an already-finished screen. The prompt engines restore raw mode in
   * their own `finally` blocks, so the terminal is never left raw across it.
   *
   * Callers fire and forget: every call site is an event handler that already
   * ignored the return value.
   */
  private async shutdown(): Promise<void> {
    this.isRunning = false;
    // Erase any half-painted wait line before the farewell lands on top of it
    this.renderer.clearThinking();
    process.stdout.write('\n' + colors.muted('  Session ended. Goodbye!\n\n'));
    // Without this, process.exit() drops whatever LangSmith has still queued —
    // and a session that ended on an error is exactly the one worth reading.
    await flushPendingTraces();
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
        buildWelcomeBanner(
          this.config.mode,
          result.model,
          this.config.sessionName,
          activeReasoningLevel(result.model),
        ),
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
   * Handles the `/help` slash command.
   *
   * On an interactive terminal the command list is navigable and the chosen
   * command runs immediately, so `/help` becomes the way to discover *and*
   * reach every command rather than a wall of text to read and retype.
   * Without a TTY it prints the static list via {@link showHelp}.
   */
  private async handleHelp(): Promise<void> {
    if (!isInteractive()) { this.showHelp(); return; }

    // Rows come from the registry, so a command added there appears here with
    // no change and can never be listed but unreachable.
    const listed = this.slashCommands.filter((command) => command.inPicker);

    const outcome = await selectOutcome<SlashCommand>({
      title: 'Slash commands',
      choices: listed.map((command) => ({
        label: command.name,
        value: command,
        hint: command.hint?.() ?? command.description,
      })),
    });

    if (outcome.status === 'interrupted') { void this.shutdown(); return; }
    if (outcome.status !== 'selected') return;

    await outcome.value.run();
  }

  /**
   * Lists the commands a partially typed input could still become.
   *
   * Nothing calls this yet. It exists because it is the one primitive Tab
   * completion and a `/` palette both need, and having it here means neither
   * has to restate the command list — which is the whole point of the registry.
   *
   * @param partial - What the user has typed so far, including the slash.
   * @returns The names of the commands still reachable.
   */
  public completions(partial: string): string[] {
    return completeSlashCommand(this.slashCommands, partial).map((c) => c.name);
  }

  /**
   * Tells the user a slash-prefixed word is not a command.
   *
   * Suggests the near matches rather than only reporting the failure, and never
   * forwards the typo to the agent: that would spend a turn and a model call to
   * answer a question the user did not ask.
   *
   * @param input - The unrecognised input.
   */
  /**
   * Pushes the turn's running spend to the wait indicator.
   *
   * Cost is omitted rather than shown as zero when the model has no published
   * price: a counter that reads $0.00 for a real spend is worse than one that
   * shows nothing, and that is precisely the failure this work started from.
   *
   * @param spend - Running spend for the current turn.
   */
  private reportSpend(spend: TurnSpend): void {
    this.renderer.noteTurnSpend?.({
      toolCalls: spend.toolCalls,
      tokens: spend.inputTokens + spend.outputTokens,
      costUsd: this.costOf(spend),
    });
  }

  /**
   * Prices the turn so far, or returns undefined when the model is unpriced.
   *
   * @param spend - Running spend for the current turn.
   * @returns Cost in USD, or undefined when no published price applies.
   */
  private costOf(spend: TurnSpend): number | undefined {
    if (spend.inputTokens === 0 && spend.outputTokens === 0) return undefined;
    try {
      return this.costTracker
        .calculateCost(this.currentModel, new TokenUsage(spend.inputTokens, spend.outputTokens))
        .amount;
    } catch {
      return undefined;
    }
  }

  /**
   * Answers conversational input locally, bypassing the agent entirely.
   *
   * A greeting is not a task, but the Deep-agent system prompt applies its
   * investigation protocol to every message: one recorded turn spent 11 tool
   * calls and 108 seconds on the word "hey" (`interactive-turns.jsonl`, audit
   * `84ad7c97`). This is the same shape as the unknown-command branch in
   * {@link promptLoop} — recognised locally, answered without spending a turn.
   *
   * Both entry points route through here on purpose. The CLI argument path in
   * {@link start} calls `sendMessage` directly, so a gate placed only in the
   * prompt loop would leave `umbra deep "hey"` paying the full cost.
   *
   * @param input - Trimmed user input.
   * @returns True when the input was answered here and must not reach the agent.
   */
  private handledAsSmallTalk(input: string): boolean {
    const kind = classifySmallTalk(input);
    if (kind === null) return false;
    this.replyToSmallTalk(kind);
    return true;
  }

  /**
   * Prints the local acknowledgement for one conversational message kind.
   *
   * The wording stays short on purpose: this is the CLI acknowledging a
   * greeting, not the agent reasoning about one. A farewell points at `/exit`
   * rather than closing the session, because leaving is the operator's call.
   *
   * @param kind - Which conversational message was recognised.
   */
  private replyToSmallTalk(kind: SmallTalkKind): void {
    const lines: Record<SmallTalkKind, string> = {
      greeting: 'Ready when you are. Describe a task, or type /help.',
      thanks: 'Any time.',
      farewell: 'Still here — type /exit to close the session.',
    };

    console.log('');
    console.log(`  ${colors.primary('⬡')}  ${lines[kind]}`);
    console.log('');
  }

  private reportUnknownCommand(input: string): void {
    const near = suggestSlashCommands(this.slashCommands, input);
    console.log('');
    console.log(colors.warning(`  Unknown command: ${input}`));
    if (near.length > 0) {
      console.log(colors.muted(`  Did you mean: ${near.map((c) => c.name).join(', ')}`));
    } else {
      console.log(colors.muted('  Type /help to see the available commands.'));
    }
    console.log('');
  }

  /**
   * Displays the list of available slash commands as static text.
   *
   * Retained as the non-interactive path for {@link handleHelp}, and still the
   * right output when the user only wants to read what exists.
   */
  private showHelp(): void {
    // Widest name, so the descriptions line up however many commands exist.
    const width = Math.max(...this.slashCommands.map((c) => c.name.length));

    console.log('');
    console.log(colors.secondary.bold('  Available slash commands:'));
    for (const command of this.slashCommands) {
      const badge = command.badge?.() ?? '';
      const styledBadge = badge
        ? (this.mentorModeActive ? colors.accent.bold(badge) : colors.muted(badge))
        : '';
      const name = colors.primary.bold(command.name.padEnd(width));
      console.log(`  ${name}${styledBadge}  — ${command.description}`);
    }
    console.log(`  ${colors.muted('Ctrl+C'.padEnd(width))}  — Exit the session`);
    console.log('');
  }
}
