import { shouldRetryEmptyTurn } from './empty-turn-retry';

describe('shouldRetryEmptyTurn', () => {
  it('retries once when a stream ends without text or tool activity', () => {
    expect(shouldRetryEmptyTurn({ hasTextOutput: false, hasToolActivity: false, retryCount: 0 }))
      .toBe(true);
  });

  it('does not retry a stream that produced text or executed a tool', () => {
    expect(shouldRetryEmptyTurn({ hasTextOutput: true, hasToolActivity: false, retryCount: 0 }))
      .toBe(false);
    expect(shouldRetryEmptyTurn({ hasTextOutput: false, hasToolActivity: true, retryCount: 0 }))
      .toBe(false);
  });

  it('does not retry again after the single allowed retry', () => {
    expect(shouldRetryEmptyTurn({ hasTextOutput: false, hasToolActivity: false, retryCount: 1 }))
      .toBe(false);
  });
});
