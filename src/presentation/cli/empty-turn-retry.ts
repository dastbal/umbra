/** Snapshot of observable activity produced by one streamed agent turn. */
export interface TurnActivity {
  /** Whether the model emitted user-visible text. */
  hasTextOutput: boolean;
  /** Whether the agent invoked at least one tool. */
  hasToolActivity: boolean;
  /** Number of empty-turn retries already attempted for this user request. */
  retryCount: number;
}

/** Maximum retries for a stream that ends silently. */
export const MAX_EMPTY_TURN_RETRIES = 1;

/**
 * Determines whether a silently completed stream gets one recovery attempt.
 * A tool-only turn is meaningful work and must never be retried merely because
 * it has no visible text yet.
 *
 * @param activity - Observed events for the current turn.
 * @returns Whether the caller should reissue the original request once.
 */
export function shouldRetryEmptyTurn(activity: TurnActivity): boolean {
  return !activity.hasTextOutput
    && !activity.hasToolActivity
    && activity.retryCount < MAX_EMPTY_TURN_RETRIES;
}
