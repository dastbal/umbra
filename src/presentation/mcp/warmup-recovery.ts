/** Decision after one index warm-up failure. */
export interface WarmupRecovery {
  readonly phase: 'ready' | 'indexing' | 'failed';
  readonly lastError: string;
  readonly retryAt?: number;
  readonly retryDelayMs?: number;
}

/** Classifies a warm-up failure against existing durable coverage. */
export function recoverWarmupFailure(error: unknown, coverageReady: boolean, attempts: number, now: number): WarmupRecovery {
  const lastError = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | undefined)?.code;
  const locked = (typeof code === 'string' && (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED')))
    || /database (?:table )?is locked/i.test(lastError);
  if (!locked) return { phase: 'failed', lastError };
  const retryDelayMs = Math.min(500 * 2 ** Math.min(attempts, 6), 30_000);
  return {
    phase: coverageReady ? 'ready' : 'indexing', lastError,
    retryAt: now + retryDelayMs, retryDelayMs,
  };
}
