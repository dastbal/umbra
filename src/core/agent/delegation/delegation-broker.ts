import type { DelegationId } from './budget-pool';
import { recordFinding, type DelegationLedger } from './delegation-registry';
import type { Mandate } from './mandate';

/** Where an answer to a delegate's question came from. */
export type AnswerSource = 'mandate' | 'human' | 'unanswered';

/** The reply handed back to a subagent that asked a question. */
export interface BrokerAnswer {
  /** Where the reply came from. */
  source: AnswerSource;
  /** Text returned to the delegate. */
  text: string;
}

/**
 * Asks the operator a question, when a channel to one exists.
 *
 * Declared as a port so this module stays free of LangGraph: the adapter that
 * raises `interrupt()` and renders the prompt lives in the tool layer. Returns
 * `undefined` when there is no operator to ask — a unit test, an embedded run,
 * a non-interactive process — which must never be reported to the delegate as
 * an answer.
 */
export type AskOperator = (
  question: string,
  options?: readonly string[],
) => Promise<string | undefined>;

/** Minimum meaningful words shared before a mandate section is quoted back. */
const RELEVANCE_THRESHOLD = 2;

/** Sections of the mandate quoted back to a delegate, in citation order. */
const CITABLE_SECTIONS: readonly { label: string; read: (mandate: Mandate) => string[] }[] = [
  { label: 'the user request', read: (m) => [m.userRequest] },
  { label: 'your objective', read: (m) => [m.objective] },
  { label: 'what is already known', read: (m) => m.knownContext },
  { label: 'in scope', read: (m) => m.inScope },
  { label: 'out of scope', read: (m) => m.outOfScope },
  { label: 'constraints', read: (m) => m.conventions },
  { label: 'definition of done', read: (m) => [m.definitionOfDone] },
];

/**
 * Answers a subagent's question without spending a turn of the orchestrator.
 *
 * ## Why this exists
 *
 * A subagent has no channel back to the agent that delegated to it: `task` is
 * one call, a prompt in and an artifact out. A delegate that is missing a
 * decisive piece of context can therefore only guess — and guessing is what
 * produced the sweep observed on 2026-08-27, where a Researcher that had not
 * been told what "improve the skills" meant queried the codebase about
 * architecture, modules, repositories, DTOs, error handling and authentication
 * until it died at the recursion limit.
 *
 * The broker gives that question somewhere to go, in a fixed order:
 *
 * 1. **The mandate**, quoted verbatim. Free, immediate, and it costs the
 *    orchestrator nothing — the orchestrator never runs.
 * 2. **The operator**, through {@link AskOperator}. This costs no model turn
 *    either; it costs the operator's attention, which is why the mandate caps
 *    how often it may happen.
 * 3. **Nothing** — an explicit statement that the question went unanswered.
 *
 * ## The rule that keeps step 1 honest
 *
 * A mandate answer is a **quotation**, never a synthesis. Relevance is decided
 * by word overlap, a heuristic that can be wrong; quoting the matched section
 * and letting the delegate judge means a wrong match wastes a few tokens, while
 * a synthesized answer from a wrong match would be a confident fabrication the
 * delegate has no way to detect.
 *
 * @param ledger - The turn's ledger, holding mandates and question counts.
 * @param delegationId - The delegation asking.
 * @param question - The delegate's question, in its own words.
 * @param askOperator - Port to the operator, when a channel exists.
 * @param options - Optional choices to offer the operator.
 * @returns The answer, always labelled with where it came from.
 */
export async function answerDelegateQuestion(
  ledger: DelegationLedger,
  delegationId: DelegationId,
  question: string,
  askOperator?: AskOperator,
  options?: readonly string[],
): Promise<BrokerAnswer> {
  const mandate = ledger.mandates.get(delegationId);

  if (mandate) {
    const quoted = quoteRelevantSections(mandate, question);
    if (quoted) return { source: 'mandate', text: quoted };
  }

  const allowance = mandate?.budget.questions ?? 0;
  const alreadyAsked = ledger.questionsAsked.get(delegationId) ?? 0;

  if (alreadyAsked >= allowance) {
    return {
      source: 'unanswered',
      text:
        `Your order does not cover this and your question allowance (${allowance}) is spent. `
        + `Continue with what you have and record this in 'unknowns'. Do not guess an answer.`,
    };
  }

  if (!askOperator) {
    return {
      source: 'unanswered',
      text:
        'No operator is available to answer. Continue with what you have and record this '
        + "in 'unknowns'. Do not treat this as an answer.",
    };
  }

  ledger.questionsAsked.set(delegationId, alreadyAsked + 1);
  const reply = await askOperator(question, options);

  if (reply === undefined || reply.trim() === '') {
    return {
      source: 'unanswered',
      text:
        'The operator did not answer. Use your judgement, state the assumption you made, '
        + "and record the question in 'unknowns'.",
    };
  }

  recordFinding(ledger, `Operator answered "${question.trim()}": ${reply.trim()}`);
  return { source: 'human', text: reply.trim() };
}

/**
 * Quotes the parts of the mandate that overlap the question.
 *
 * @param mandate - The order this delegate received.
 * @param question - The delegate's question.
 * @returns The quoted sections, or `undefined` when nothing was relevant enough.
 */
function quoteRelevantSections(mandate: Mandate, question: string): string | undefined {
  const asked = meaningfulWords(question);
  if (asked.size === 0) return undefined;

  const matches: string[] = [];
  for (const section of CITABLE_SECTIONS) {
    for (const entry of section.read(mandate)) {
      if (overlap(asked, meaningfulWords(entry)) >= RELEVANCE_THRESHOLD) {
        matches.push(`- (${section.label}) ${entry}`);
      }
    }
  }

  if (matches.length === 0) return undefined;

  return (
    'Your order already covers this. Quoted from it, verbatim:\n\n'
    + `${matches.slice(0, 4).join('\n')}\n\n`
    + 'Decide from this. If it genuinely does not answer your question, ask again more specifically.'
  );
}

/**
 * Words too common to signal relevance.
 *
 * Deliberately crude: this list decides whether to *quote*, never what to
 * assert, so a false positive costs a few tokens and a false negative costs one
 * escalation to the operator.
 */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'your', 'with', 'that', 'this', 'from',
  'what', 'which', 'should', 'would', 'could', 'have', 'has', 'was', 'were', 'does', 'did',
  'about', 'into', 'they', 'them', 'their', 'there', 'here', 'when', 'where', 'how', 'why',
  'any', 'all', 'can', 'may', 'must', 'need', 'want', 'use', 'used', 'using', 'its',
]);

function meaningfulWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9_/.-]+/)
      .filter((word) => word.length >= 3 && !STOP_WORDS.has(word)),
  );
}

function overlap(left: Set<string>, right: Set<string>): number {
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared;
}
