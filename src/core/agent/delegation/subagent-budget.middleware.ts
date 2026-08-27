import { ToolMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import { currentTurn, type DelegationLedger } from './delegation-registry';

/** Tools that do not draw on the delegate's tool budget. */
const UNBUDGETED_TOOLS = new Set(['ask_delegator', 'write_todos']);

/**
 * Instruction given to a delegate that has spent its allowance.
 *
 * It states the contract rather than merely forbidding tools, because a model
 * told only to stop produces either a refusal or an invented result. Telling it
 * exactly which status to use, and that gaps must be named, is what turns an
 * exhausted budget into a usable handoff instead of a dead run.
 */
const EXHAUSTED_INSTRUCTION =
  '\n\nBUDGET SPENT. You have used every tool attempt allotted to this delegation. '
  + 'Do not request another tool. Return your artifact now with status "partial", '
  + 'listing in "unknowns" everything you could not verify and in "openQuestions" what you '
  + 'would ask if the work continued. Report only what you actually verified — an invented '
  + 'finding is worse than an admitted gap.';

/**
 * Creates the middleware that holds a subagent to the budget it was granted.
 *
 * ## Why a subagent needs its own budget at all
 *
 * `recursionLimit` looks like a per-turn ceiling and is not. `deepagents`
 * spreads the parent's config into the delegate's invocation and then calls
 * `subagent.invoke`, which begins a **fresh** graph run — so a delegate starts
 * with the same numeric allowance the orchestrator had, again. On 2026-08-27 a
 * Researcher spent fifty transitions of its own while the orchestrator, which
 * believed it was bounding the turn, learned nothing until the exception
 * arrived.
 *
 * ## What is not counted
 *
 * `ask_delegator` and `write_todos` do not draw on the tool budget. Asking has
 * its own allowance in the mandate, and charging a delegate for asking would
 * push it back towards the behaviour this whole mechanism exists to stop:
 * guessing, then exploring to cover the guess. `write_todos` writes to a state
 * key subagents do not even share with the parent; charging for it would spend
 * the turn's money on bookkeeping nobody reads.
 *
 * ## When no ledger is open
 *
 * Every mode that does not delegate — `umbra deep`, `umbra analyze`, any
 * embedded use — has no ledger, and the middleware then does nothing at all.
 * Absence of a budget is never treated as an error, only as "this accounting is
 * not in force here".
 *
 * @returns Middleware suitable for a `SubAgent` specification.
 */
export function createSubagentBudgetMiddleware() {
  return createMiddleware({
    name: 'SubagentBudget',
    wrapToolCall: async (request, handler) => {
      const scope = readScope(request.runtime);
      if (!scope) return handler(request);

      if (UNBUDGETED_TOOLS.has(request.toolCall.name)) return handler(request);

      if (scope.ledger.pool.isExhausted(scope.delegationId)) {
        return new ToolMessage({
          tool_call_id: request.toolCall.id ?? '',
          content:
            'Budget spent: this delegation has used every tool attempt it was granted. '
            + 'Return your artifact now with status "partial" and list what stayed unknown.',
        });
      }

      scope.ledger.pool.consume(scope.delegationId);
      return handler(request);
    },
    wrapModelCall: async (request, handler) => {
      const scope = readScope(request.runtime);
      if (!scope || !scope.ledger.pool.isExhausted(scope.delegationId)) return handler(request);

      return handler({
        ...request,
        tools: [],
        systemPrompt: `${request.systemPrompt ?? ''}${EXHAUSTED_INSTRUCTION}`,
      });
    },
  });
}

/** The delegation a running subagent belongs to. */
interface DelegationScope {
  /** The turn ledger holding the shared budget. */
  ledger: DelegationLedger;
  /** The delegation currently running. */
  delegationId: string;
}

/**
 * Finds which delegation the current subagent run belongs to.
 *
 * The delegate itself carries no identity: it receives a rendered order and
 * nothing else. The association comes from the thread — which `deepagents`
 * does pass down — plus the pointer the orchestration guard sets before handing
 * control over.
 *
 * @param runtime - The LangGraph runtime for the current node.
 * @returns The delegation scope, or `undefined` when no budget is in force.
 */
function readScope(runtime: unknown): DelegationScope | undefined {
  const configurable = (runtime as { configurable?: Record<string, unknown> } | undefined)?.configurable;
  const threadId = configurable?.['thread_id'];
  if (typeof threadId !== 'string') return undefined;

  const ledger = currentTurn(threadId);
  if (!ledger?.activeDelegationId) return undefined;

  return { ledger, delegationId: ledger.activeDelegationId };
}
