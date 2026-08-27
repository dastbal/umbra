import { z } from 'zod';
import { tool } from '@langchain/core/tools';
import { getConfig, interrupt, isGraphInterrupt } from '@langchain/langgraph';
import { answerDelegateQuestion } from '../../agent/delegation/delegation-broker';
import { currentTurn } from '../../agent/delegation/delegation-registry';
import { log } from '../utils/logger';

/** Marks an interrupt as a delegate's question rather than an approval request. */
export const DELEGATE_QUESTION_KIND = 'delegate_question';

/**
 * The payload the CLI receives when a subagent asks something.
 *
 * The `kind` discriminator is not decoration. `ChatSession#handleHITL` assumed
 * every interrupt was an approval — `actionRequests` plus `reviewConfigs` — and
 * without a type field a question would render as if it were an authorization
 * to delete something. Confusing those two on screen is worse than not having
 * the feature at all.
 */
export interface DelegateQuestionRequest {
  /** Discriminator separating a question from an approval request. */
  kind: typeof DELEGATE_QUESTION_KIND;
  /** The delegate's question, in its own words. */
  question: string;
  /** Choices to offer the operator, when the delegate supplied any. */
  options?: string[];
  /** The delegation asking, for display. */
  askedBy: string;
}

/** The operator's reply to a delegate's question. */
export interface DelegateQuestionResponse {
  /** The answer, or absent when the operator declined to answer. */
  answer?: string;
}

/**
 * Lets a subagent ask about its own order instead of guessing.
 *
 * ## Why a delegate needs this
 *
 * `task` is a single call: a prompt in, an artifact out. A delegate that is
 * missing a decisive piece of context has, without this tool, exactly one
 * option — guess. On 2026-08-27 a Researcher that had not been told what
 * "improve the skills" meant guessed, and swept the codebase until it died at
 * the recursion limit.
 *
 * ## What it costs
 *
 * The first resort is the order itself, quoted back by the broker: free, and
 * the orchestrator never runs, so it spends none of its own turns. Only a
 * question the order does not cover reaches the operator, and the mandate caps
 * how many of those a delegate may ask.
 *
 * ## Re-execution
 *
 * `interrupt()` throws to suspend the graph, and on resume this whole tool body
 * runs again from the top. Nothing here may perform a side effect before the
 * interrupt returns — the same rule `requestApproval` documents, for the same
 * reason.
 */
export const askDelegatorTool = tool(
  async ({ question, options }: { question: string; options?: string[] }) => {
    const threadId = readThreadId();
    const ledger = currentTurn(threadId);

    if (!ledger?.activeDelegationId) {
      return 'No delegation context is active, so there is nobody to ask. '
        + "Continue with what you have and record the question in 'unknowns'.";
    }

    const delegationId = ledger.activeDelegationId;

    const answer = await answerDelegateQuestion(
      ledger,
      delegationId,
      question,
      operatorChannelEnabled() ? askOperator : undefined,
      options,
    );

    log.sys(`ask_delegator (${delegationId}) answered from: ${answer.source}`);
    return answer.text;
  },
  {
    name: 'ask_delegator',
    description:
      'Ask about your own assignment when the order you received does not settle it. '
      + 'Answered from that order when it covers the question, otherwise put to the operator. '
      + 'Use it instead of guessing, and instead of exploring to find out what was meant.',
    schema: z.object({
      question: z.string().describe('The specific thing you need settled to continue.'),
      options: z
        .array(z.string())
        .optional()
        .describe('Concrete choices to offer, when the question has a small set of answers.'),
    }),
  },
);

/**
 * Reports whether a delegate may suspend the run to reach the operator.
 *
 * ## Why this is off by default
 *
 * A subagent graph has no checkpointer. `getSubagents` in `deepagents` builds
 * each one with `createAgent({ model, systemPrompt, tools, middleware, name })`
 * — the checkpointer is passed only to the top-level agent. `interrupt()`
 * suspends by persisting state and waiting to be resumed with a `Command`, and
 * a graph that cannot persist has nothing to resume.
 *
 * Observed live on 2026-08-27, on the first real run of this channel: the
 * Researcher asked a question, the run stopped, and 145 seconds later the
 * operator was still looking at a spinner. Nobody was ever going to be asked.
 *
 * The mandate half of this tool is unaffected and stays on: a question the order
 * already answers is answered from the order, quoted, with no suspension
 * involved. That is the path that carries most of the value.
 *
 * `UMBRA_SUBAGENT_QUESTIONS=1` re-enables the escalation for whoever is working
 * on making it suspend properly. This mirrors `UMBRA_SIMPLE_PROMPT=1`
 * (ADR-012): an unproven path ships reachable, not enabled.
 *
 * @returns Whether the operator channel may be used.
 */
function operatorChannelEnabled(): boolean {
  return process.env['UMBRA_SUBAGENT_QUESTIONS'] === '1';
}

/**
 * Puts a question to the operator through the LangGraph interrupt channel.
 *
 * @param question - The delegate's question.
 * @param options - Choices to offer, when the delegate supplied any.
 * @returns The operator's answer, or `undefined` when there is nobody to ask
 * or the operator declined to answer.
 */
async function askOperator(
  question: string,
  options?: readonly string[],
): Promise<string | undefined> {
  const request: DelegateQuestionRequest = {
    kind: DELEGATE_QUESTION_KIND,
    question,
    options: options ? [...options] : undefined,
    askedBy: 'subagent',
  };

  let response: DelegateQuestionResponse | undefined;
  try {
    response = interrupt(request) as DelegateQuestionResponse | undefined;
  } catch (error: unknown) {
    // A GraphInterrupt is how LangGraph suspends so the operator can answer.
    // Swallowing it here would resume the delegate with a fabricated silence.
    if (isGraphInterrupt(error)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    log.error(`Question channel unavailable: ${message}`);
    return undefined;
  }

  const answer = response?.answer?.trim();
  return answer === undefined || answer === '' ? undefined : answer;
}

/**
 * Reads the thread this delegation belongs to.
 *
 * `deepagents` spreads the parent's config into the subagent's invocation, so a
 * tool running inside a delegate sees the same `thread_id` as the orchestrator
 * that issued the order. That is what lets a separate graph find the turn
 * ledger at all.
 *
 * @returns The thread identifier, or `undefined` outside a graph run.
 */
function readThreadId(): string | undefined {
  try {
    const configurable = getConfig()?.configurable as Record<string, unknown> | undefined;
    const threadId = configurable?.['thread_id'];
    return typeof threadId === 'string' ? threadId : undefined;
  } catch {
    return undefined;
  }
}
