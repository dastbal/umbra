import {
  assertDelegationAllowed,
  evaluateDelegation,
  OrchestrationGuardViolation,
  type DelegationHistory,
} from './orchestration-policy';

const emptyHistory: DelegationHistory = {
  routeRequiresImplementation: true,
  researcherCalls: 0,
  coderCalls: 0,
  verifierResults: [],
  researcherReady: false,
  researcherBlocked: false,
};

describe('evaluateDelegation', () => {
  it('blocks every subagent for a read-only route', () => {
    const decision = evaluateDelegation(
      { ...emptyHistory, routeRequiresImplementation: false },
      'researcher',
      2,
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('read-only');
  });

  it('requires a ready researcher handoff before the Coder', () => {
    const decision = evaluateDelegation(
      { ...emptyHistory, researcherCalls: 1 },
      'coder',
      2,
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('Researcher');
  });

  it('prevents implementation when the researcher is blocked', () => {
    const decision = evaluateDelegation(
      { ...emptyHistory, researcherCalls: 1, researcherBlocked: true },
      'coder',
      2,
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('blocked');
  });

  it('requires the Coder before verification', () => {
    const decision = evaluateDelegation(
      { ...emptyHistory, researcherCalls: 1, researcherReady: true },
      'verifier',
      2,
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('Coder');
  });

  it('allows only the configured number of failed-verification corrections', () => {
    const history: DelegationHistory = {
      ...emptyHistory,
      researcherCalls: 1,
      researcherReady: true,
      coderCalls: 3,
      verifierResults: ['failed', 'failed'],
    };

    expect(evaluateDelegation(history, 'coder', 2).allowed).toBe(false);
    expect(evaluateDelegation({ ...history, coderCalls: 2 }, 'coder', 2).allowed).toBe(true);
  });

  it('ends the turn rather than exposing a rejected transition to the model', () => {
    const decision = evaluateDelegation(emptyHistory, 'coder', 2);

    expect(() => assertDelegationAllowed(decision)).toThrow(OrchestrationGuardViolation);
  });
});
