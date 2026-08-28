/** A Verifier outcome that is relevant to routing the next delegation. */
export type VerificationStatus = 'passed' | 'failed' | 'blocked';

/** Minimal event-derived state needed to enforce the orchestration protocol. */
export interface DelegationHistory {
  /** Whether the current user route is permitted to change files. */
  routeRequiresImplementation: boolean;
  /** Number of Researcher delegations in the current turn. */
  researcherCalls: number;
  /** Number of Coder delegations in the current turn. */
  coderCalls: number;
  /** Completed Verifier artifacts, in chronological order. */
  verifierResults: VerificationStatus[];
  /** Whether the Researcher explicitly returned an implementation-ready handoff. */
  researcherReady: boolean;
  /** Whether the Researcher explicitly returned a blocked handoff. */
  researcherBlocked: boolean;
}

/** Result of checking a requested transition in the workflow. */
export interface DelegationDecision {
  /** Whether the requested subagent may run. */
  allowed: boolean;
  /** Human-readable explanation for an enforced rejection. */
  reason?: string;
}

/** Signals an attempted workflow transition that must terminate the current turn. */
export class OrchestrationGuardViolation extends Error {
  /** @param reason - Deterministic explanation of the rejected transition. */
  public constructor(reason: string) {
    super(reason);
    this.name = 'OrchestrationGuardViolation';
  }
}

/** Names of the declarative subagents guarded by the workflow. */
export type GuardedSubagent = 'researcher' | 'coder' | 'verifier';

/**
 * Enforces the deterministic portion of the Researcher → Coder → Verifier
 * lifecycle. It is deliberately pure so it can be tested independently from
 * LangGraph and audited from persisted task events.
 *
 * @param history - Events observed in the current interactive turn.
 * @param requested - Subagent requested by the Supervisor.
 * @param maxRetries - Maximum correction cycles permitted after verification.
 * @returns Allow/deny decision for the requested transition.
 */
export function evaluateDelegation(
  history: DelegationHistory,
  requested: GuardedSubagent,
  maxRetries: number,
): DelegationDecision {
  if (!history.routeRequiresImplementation) {
    return { allowed: false, reason: 'The current route is read-only; subagent delegation is not permitted.' };
  }

  if (requested === 'researcher') {
    return history.researcherCalls === 0
      ? { allowed: true }
      : { allowed: false, reason: 'Researcher already ran for this request; use its handoff.' };
  }

  if (history.researcherBlocked) {
    return { allowed: false, reason: 'Researcher returned blocked; implementation must not start.' };
  }

  if (!history.researcherReady) {
    return { allowed: false, reason: 'Coder requires a ready Researcher handoff first.' };
  }

  if (requested === 'verifier') {
    return history.coderCalls > 0
      ? { allowed: true }
      : { allowed: false, reason: 'Verifier requires a completed Coder attempt first.' };
  }

  if (history.coderCalls === 0) return { allowed: true };

  const lastVerification = history.verifierResults.at(-1);
  if (lastVerification !== 'failed') {
    return {
      allowed: false,
      reason: 'A Coder correction requires the latest Verifier result to be failed.',
    };
  }

  const correctionAttempts = history.coderCalls - 1;
  return correctionAttempts < maxRetries
    ? { allowed: true }
    : { allowed: false, reason: `Correction budget exhausted after ${maxRetries} retries.` };
}

/**
 * Converts a denied transition into a terminal error before the LLM can
 * reinterpret a guard response as a normal tool result.
 *
 * @param decision - Policy decision returned for a requested delegation.
 * @throws {OrchestrationGuardViolation} When the transition is denied.
 */
export function assertDelegationAllowed(decision: DelegationDecision): void {
  if (!decision.allowed) {
    throw new OrchestrationGuardViolation(
      decision.reason ?? 'Invalid orchestration transition.',
    );
  }
}
