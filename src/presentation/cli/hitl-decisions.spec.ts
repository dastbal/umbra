/**
 * Tests for the HITL decision menu construction (ADR-011).
 *
 * The prompt itself is covered by `interactive-select.spec.ts`. What matters
 * here is the mapping from the gate's `allowedDecisions` to what the operator
 * is offered, because that is what decides whether a permitted decision can be
 * reached at all.
 */

import { buildDecisionChoices, rejectionDecision } from './chat-session';

describe('buildDecisionChoices', () => {
  it('offers exactly the decisions the gate allows', () => {
    const choices = buildDecisionChoices(['approve', 'reject']);

    expect(choices.map((c) => c.value)).toEqual(['reject', 'approve']);
  });

  it('puts reject first regardless of input order so Enter fails closed', () => {
    const choices = buildDecisionChoices(['reject', 'edit', 'approve']);

    expect(choices.map((c) => c.value)).toEqual(['reject', 'edit', 'approve']);
  });

  it('surfaces a decision type it does not recognise instead of dropping it', () => {
    // Hiding an option the gate permitted would misrepresent the operator's
    // real choices, which is worse than an unpolished label.
    const choices = buildDecisionChoices(['approve', 'escalate']);

    expect(choices.map((c) => c.value)).toEqual(['approve', 'escalate']);
    expect(choices[1].label).toBe('escalate');
  });

  it('never invents a decision the gate did not allow', () => {
    const choices = buildDecisionChoices(['reject']);

    expect(choices.map((c) => c.value)).toEqual(['reject']);
  });

  it('gives every row a label and a value the prompt can resolve', () => {
    for (const choice of buildDecisionChoices(['approve', 'edit', 'reject'])) {
      expect(typeof choice.label).toBe('string');
      expect(choice.label.length).toBeGreaterThan(0);
      expect(choice.value).toBeDefined();
      expect(choice.separator).toBeUndefined();
      expect(choice.disabled).toBeUndefined();
    }
  });
});

describe('rejectionDecision', () => {
  it('tells the model not to retry the gated tool', () => {
    const decision = rejectionDecision();

    expect(decision.type).toBe('reject');
    // Without this instruction the model reads a bare rejection as a transient
    // failure and calls the same gated tool again (ADR-011).
    expect(decision.message).toContain('Do not retry');
  });
});
