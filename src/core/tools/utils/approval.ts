import { interrupt, isGraphInterrupt } from '@langchain/langgraph';
import { log } from './logger';

/** A single action put in front of a human, mirroring LangChain's `ActionRequest`. */
interface ApprovalActionRequest {
  name: string;
  args: Record<string, unknown>;
  description?: string;
}

/** The reviewer policy for one action, mirroring LangChain's `ReviewConfig`. */
interface ApprovalReviewConfig {
  actionName: string;
  allowedDecisions: Array<'approve' | 'edit' | 'reject'>;
}

/** The payload a human reviewer receives, mirroring LangChain's `HITLRequest`. */
interface ApprovalRequest {
  actionRequests: ApprovalActionRequest[];
  reviewConfigs: ApprovalReviewConfig[];
}

/** The reviewer's answer, mirroring LangChain's `HITLResponse`. */
interface ApprovalResponse {
  decisions?: Array<{ type?: 'approve' | 'edit' | 'reject'; message?: string }>;
}

/**
 * Suspends the graph and asks the operator to authorize one tool action.
 *
 * This is the consumer the `require_approval` verdict never had: the policy
 * decides *whether* a human is needed, and this raises the LangGraph interrupt
 * the CLI already knows how to render (see `ChatSession.handleHITL`). The
 * payload deliberately mirrors LangChain's own HITL contract so the same
 * handler serves both sources.
 *
 * ## Re-execution
 * `interrupt()` throws to suspend, and on resume the **whole tool body runs
 * again** from the top, with this call returning the decision. Every caller must
 * therefore perform its side effect *after* this returns — moving a write above
 * this line would execute it once before the human is even asked.
 *
 * ## No channel means no approval
 * Outside a checkpointed graph run (unit tests, embedded library use) there is
 * nobody to ask, so the request is refused rather than silently allowed.
 *
 * @param toolName - The tool requesting authorization.
 * @param args - The arguments shown to the operator.
 * @param reason - The policy reason explaining why approval is required.
 * @returns `true` only when a human explicitly approved.
 */
export function requestApproval(
  toolName: string,
  args: Record<string, unknown>,
  reason: string,
): boolean {
  const request: ApprovalRequest = {
    actionRequests: [{ name: toolName, args, description: reason }],
    reviewConfigs: [{ actionName: toolName, allowedDecisions: ['approve', 'reject'] }],
  };

  let response: ApprovalResponse | undefined;
  try {
    response = interrupt(request) as ApprovalResponse | undefined;
  } catch (error: unknown) {
    // A GraphInterrupt is not a failure: it is how LangGraph suspends the run so
    // the operator can answer. Swallowing it would execute the action unreviewed.
    if (isGraphInterrupt(error)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    log.error(`Approval channel unavailable for ${toolName}: ${message}`);
    return false;
  }

  return response?.decisions?.[0]?.type === 'approve';
}

/**
 * Re-throws a graph suspension so a surrounding `catch` cannot swallow it.
 *
 * Any tool that calls {@link requestApproval} inside a `try` block **must** call
 * this first in its `catch`. `interrupt()` signals "pause and ask the human" by
 * throwing; a generic `catch (error)` turns that signal into an ordinary tool
 * failure, the graph never suspends, and the operator is never asked — the exact
 * failure this gate exists to prevent.
 *
 * @param error - The value caught by the surrounding handler.
 * @throws The original error when it is a LangGraph suspension.
 */
export function rethrowIfSuspension(error: unknown): void {
  if (isGraphInterrupt(error)) throw error;
}
