/**
 * How a delegation ended, in the only terms the orchestration policy needs.
 *
 * - `decided` — the delegate produced a valid artifact. Somebody made a call,
 *   even if the call was "blocked" or "failed". The attempt is spent.
 * - `partial` — the delegate ran out of budget and handed back what it had
 *   verified. The attempt is spent, but the work may be continued.
 * - `refused` — the delegation never started: an incomplete mandate or a
 *   policy denial. Nothing was attempted and nothing was learned.
 * - `infrastructure-failure` — the delegate died without deciding anything:
 *   recursion limit, provider rejection, timeout, transport error.
 */
export type DelegationOutcomeKind =
  | 'decided'
  | 'partial'
  | 'refused'
  | 'infrastructure-failure';

/** The classification of one finished delegation. */
export interface DelegationOutcome {
  /** What kind of ending this was. */
  kind: DelegationOutcomeKind;
  /**
   * Whether this ending consumes one of the role's permitted attempts.
   *
   * Only an ending in which the delegate actually decided something does. The
   * distinction is not bookkeeping: `evaluateDelegation` allows a Researcher
   * while `researcherCalls === 0`, so counting a crash as an attempt leaves the
   * turn permanently unable to research — the orchestrator asks again and is
   * told *"Researcher already ran for this request"* with no research in hand.
   * That exact dead end was observed on 2026-08-27.
   */
  consumesAttempt: boolean;
  /**
   * Whether delegating again could plausibly do better.
   *
   * Retryable does **not** mean free. Every retry is granted from the same
   * turn budget, so a failure that repeats runs out of money on its own and
   * needs no separate retry counter.
   */
  retryable: boolean;
  /** Deterministic explanation, safe to show the operator and the model. */
  reason: string;
}

/** What is known about a finished delegation. */
export interface FinishedDelegation {
  /** `status` read from the returned artifact, when one was returned. */
  artifactStatus?: string;
  /** The error that ended the delegation, when it ended in one. */
  error?: unknown;
}

/**
 * Message fragments that identify an ending nobody decided.
 *
 * Matched case-insensitively against the error text. Each entry corresponds to
 * a failure this project has actually observed rather than to a category that
 * merely could exist.
 */
const INFRASTRUCTURE_SIGNATURES: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /recursion limit/i, reason: 'the delegate hit the graph recursion limit' },
  { pattern: /GRAPH_RECURSION_LIMIT/i, reason: 'the delegate hit the graph recursion limit' },
  { pattern: /did not match expected schema/i, reason: 'the provider rejected a tool call schema' },
  { pattern: /\b(4\d{2}|5\d{2})\b.*(request|response|status)/i, reason: 'the provider rejected the request' },
  { pattern: /timed? ?out/i, reason: 'the delegate timed out' },
  { pattern: /ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|fetch failed/i, reason: 'the transport failed' },
];

/** Artifact states in which the delegate reached a conclusion. */
const DECIDED_STATUSES: readonly string[] = ['ready', 'blocked', 'passed', 'failed'];

/**
 * Classifies how a delegation ended.
 *
 * The classification is pure and takes no LangGraph types, so the orchestration
 * policy can be audited from persisted events — the same reason
 * `orchestration-policy.ts` is separate from its middleware.
 *
 * @param finished - What is known about the ended delegation.
 * @returns The outcome, with its effect on the attempt count.
 */
export function classifyDelegationOutcome(finished: FinishedDelegation): DelegationOutcome {
  const status = finished.artifactStatus?.trim().toLowerCase();

  if (status !== undefined && DECIDED_STATUSES.includes(status)) {
    return {
      kind: 'decided',
      consumesAttempt: true,
      retryable: false,
      reason: `The delegate returned a '${status}' artifact.`,
    };
  }

  if (status === 'partial') {
    return {
      kind: 'partial',
      consumesAttempt: true,
      retryable: true,
      reason: 'The delegate exhausted its budget and returned what it had verified.',
    };
  }

  if (isRefusal(finished.error)) {
    return {
      kind: 'refused',
      consumesAttempt: false,
      retryable: true,
      reason: 'The delegation was refused before it started; repair the order and issue it again.',
    };
  }

  if (finished.error !== undefined) {
    const text = errorText(finished.error);
    const signature = INFRASTRUCTURE_SIGNATURES.find((one) => one.pattern.test(text));
    return {
      kind: 'infrastructure-failure',
      consumesAttempt: false,
      retryable: true,
      reason: signature
        ? `The delegate produced no artifact: ${signature.reason}.`
        : 'The delegate produced no artifact and decided nothing.',
    };
  }

  return {
    kind: 'infrastructure-failure',
    consumesAttempt: false,
    retryable: true,
    reason: 'The delegation ended without an artifact and without an error.',
  };
}

function isRefusal(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'IncompleteMandateError' || error.name === 'OrchestrationGuardViolation';
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) ?? '';
  } catch {
    return '';
  }
}
