import { recoverWarmupFailure } from './warmup-recovery';

describe('warm-up recovery', () => {
  it('serves durable coverage and schedules a refresh after a SQLite lock', () => {
    const error = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    expect(recoverWarmupFailure(error, true, 0, 1000)).toMatchObject({
      phase: 'ready', retryAt: 1500, retryDelayMs: 500, lastError: 'database is locked',
    });
  });

  it('keeps an uncovered index retryable with bounded exponential backoff', () => {
    const error = Object.assign(new Error('database table is locked'), { code: 'SQLITE_LOCKED' });
    expect(recoverWarmupFailure(error, false, 3, 1000)).toMatchObject({
      phase: 'indexing', retryAt: 5000, retryDelayMs: 4000,
    });
  });

  it('does not retry a permanent provider failure', () => {
    expect(recoverWarmupFailure(new Error('invalid model'), true, 0, 1000)).toMatchObject({
      phase: 'failed', lastError: 'invalid model',
    });
  });
});
