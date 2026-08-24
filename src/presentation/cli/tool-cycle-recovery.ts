/** Inputs used to decide whether an interrupted tool cycle can be recovered. */
export interface ToolCycleRecoveryInput {
  /** Error raised while the agent processed the current turn. */
  errorMessage: string;
  /** Whether the current turn executed a tool before failing. */
  hasToolActivity: boolean;
  /** Whether this named session has a scoped recovery callback. */
  canRecoverSession: boolean;
}

/**
 * Detects the Vertex bad-request failure that can leave a named session ending
 * with a tool result and no assistant response.
 *
 * The caller must reset only the affected session. It must not replay the
 * original request because a completed tool may have had side effects.
 *
 * @param input - Observable error and session-state details.
 * @returns Whether the session should be rebuilt before accepting new input.
 */
export function shouldRecoverToolCycle(input: ToolCycleRecoveryInput): boolean {
  return input.hasToolActivity
    && input.canRecoverSession
    && /Google request failed with status code 400/i.test(input.errorMessage);
}
