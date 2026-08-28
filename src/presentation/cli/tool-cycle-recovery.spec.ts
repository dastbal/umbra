import { shouldRecoverToolCycle } from './tool-cycle-recovery';

describe('shouldRecoverToolCycle', () => {
  it('recovers a named session after Vertex rejects a completed tool cycle', () => {
    expect(shouldRecoverToolCycle({
      errorMessage: 'Google request failed with status code 400',
      hasToolActivity: true,
      canRecoverSession: true,
    })).toBe(true);
  });

  it('does not reset a session for unrelated failures or before a tool ran', () => {
    expect(shouldRecoverToolCycle({
      errorMessage: 'Google request failed with status code 400',
      hasToolActivity: false,
      canRecoverSession: true,
    })).toBe(false);
    expect(shouldRecoverToolCycle({
      errorMessage: 'Request timed out',
      hasToolActivity: true,
      canRecoverSession: true,
    })).toBe(false);
  });
});
