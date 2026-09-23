import chalk from 'chalk';
import { colors } from './theme';
import { isInteractive, selectOutcome, type SelectChoice } from './interactive-select';
import { askText } from './prompts';
import { DELEGATE_QUESTION_KIND } from '../../core/tools/interaction/ask-delegator.tool';

/**
 * What putting one suspension in front of the operator needs from the session.
 *
 * Passed in rather than reached for, so this module owns *how* a suspension is
 * rendered and answered while `ChatSession` keeps owning the run it belongs to.
 */
export interface SuspensionPrompt {
  /** Renders the action awaiting authorization. */
  showAction(name: string, args: unknown): void;
  /** Clears the wait indicator before writing to the screen. */
  clearThinking(): void;
  /** Asks the operator to decide, offering exactly the allowed decisions. */
  askDecision(allowed: string[]): Promise<{ type: string; message?: string }>;
}

/**
 * Renders one suspension and collects the value that answers it.
 *
 * A question from a delegate is not an approval request. Without this
 * discriminator it would render as one — see {@link answerDelegateQuestion}.
 *
 * @param value - The payload the suspended tool passed to `interrupt()`.
 * @param prompt - The screen and the operator, as this module needs them.
 * @returns The value to hand back to that tool.
 */
export async function answerSuspension(value: unknown, prompt: SuspensionPrompt): Promise<unknown> {
  const request = value as any;

  if (request?.kind === DELEGATE_QUESTION_KIND) {
    return answerDelegateQuestion(request, prompt);
  }

  const actionRequests: any[] = request?.actionRequests ?? [];
  const reviewConfigs: any[]  = request?.reviewConfigs ?? [];
  const decisions: any[] = [];

  for (let i = 0; i < actionRequests.length; i++) {
    const action = actionRequests[i];
    prompt.showAction(action.name, action.args);

    const allowed: string[] = reviewConfigs[i]?.allowedDecisions ?? ['approve', 'reject'];
    const decision = await prompt.askDecision(allowed);

    if (decision.type === 'approve') {
      process.stdout.write(colors.accent('  ✓ Approved\n'));
    } else if (decision.type === 'edit') {
      process.stdout.write(colors.warning('  ✎ Sent back with feedback\n'));
    } else {
      process.stdout.write(colors.danger('  ✗ Rejected\n'));
    }

    // The decision echoes the action it answers. `requestApproval` refuses a
    // decision that does not match, because inside one task LangGraph hands out
    // resume values by position and an earlier answer would otherwise satisfy a
    // later question.
    decisions.push(action.actionId === undefined ? decision : { ...decision, actionId: action.actionId });
  }

  return { decisions };
}

/**
 * Renders a subagent question and collects the answer.
 *
 * A question is not an approval, and before this branch existed every interrupt
 * was read as one — `actionRequests` plus `reviewConfigs`. Without the
 * discriminator a delegate asking what "improve the skills" meant would have
 * rendered as an authorization to perform an action, which is a worse outcome
 * than not having the feature.
 *
 * Cancelling is deliberately not an answer. Escape on the security gate means
 * reject; here it means the operator declined to answer, and the delegate is
 * told exactly that so it records an unknown instead of inventing a reply.
 *
 * @param request - The question raised by a delegate.
 * @param prompt - The screen and the operator, as this module needs them.
 * @returns The reply to hand back to the waiting delegate.
 */
async function answerDelegateQuestion(
  request: { question: string; options?: string[]; questionId?: string },
  prompt: SuspensionPrompt,
): Promise<{ answer?: string; questionId?: string }> {
  prompt.clearThinking();
  process.stdout.write(`\n  ${colors.accent('?')} ${chalk.bold('A subagent is asking:')}\n`);
  process.stdout.write(`  ${request.question}\n\n`);

  const answer = await readAnswer(request.options);

  if (answer === undefined) {
    process.stdout.write(colors.muted('  — not answered; the subagent will record it as unknown\n'));
  }

  // The question id travels back untouched: `askOperator` refuses an answer that
  // does not name the question it answers, because within one task LangGraph
  // hands resume values out by position.
  return { answer, questionId: request.questionId };
}

/**
 * Collects the operator answer, as a menu when choices were offered.
 *
 * @param options - Choices supplied by the delegate, when it supplied any.
 * @returns The answer, or `undefined` when the operator did not give one.
 */
async function readAnswer(options?: string[]): Promise<string | undefined> {
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
