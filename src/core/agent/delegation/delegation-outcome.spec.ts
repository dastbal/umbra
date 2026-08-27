import { classifyDelegationOutcome } from './delegation-outcome';
import { IncompleteMandateError } from './mandate';
import { OrchestrationGuardViolation } from '../orchestration-policy';

describe('classifyDelegationOutcome', () => {
  it.each(['ready', 'blocked', 'passed', 'failed'])(
    "treats a '%s' artifact as a decision that spends the attempt",
    (artifactStatus) => {
      const outcome = classifyDelegationOutcome({ artifactStatus });

      expect(outcome.kind).toBe('decided');
      expect(outcome.consumesAttempt).toBe(true);
      expect(outcome.retryable).toBe(false);
    },
  );

  it('treats a partial handoff as spent but continuable', () => {
    const outcome = classifyDelegationOutcome({ artifactStatus: 'partial' });

    expect(outcome.kind).toBe('partial');
    expect(outcome.consumesAttempt).toBe(true);
    expect(outcome.retryable).toBe(true);
  });

  it('does not spend the attempt when the delegate hit the recursion limit', () => {
    const outcome = classifyDelegationOutcome({
      error: new Error('Recursion limit of 50 reached without hitting a stop condition.'),
    });

    expect(outcome.kind).toBe('infrastructure-failure');
    expect(outcome.consumesAttempt).toBe(false);
    expect(outcome.reason).toContain('recursion limit');
  });

  it('does not spend the attempt when the provider rejected a tool schema', () => {
    const outcome = classifyDelegationOutcome({
      error: new Error("Error invoking tool 'read_file': Received tool input did not match expected schema"),
    });

    expect(outcome.consumesAttempt).toBe(false);
    expect(outcome.reason).toContain('tool call schema');
  });

  it.each([
    new Error('socket hang up'),
    new Error('request failed with status 503'),
    new Error('the request timed out'),
  ])('classifies %s as infrastructure rather than a decision', (error) => {
    expect(classifyDelegationOutcome({ error }).kind).toBe('infrastructure-failure');
  });

  it('treats an incomplete mandate as a refusal that costs nothing', () => {
    const outcome = classifyDelegationOutcome({ error: new IncompleteMandateError(['userRequest']) });

    expect(outcome.kind).toBe('refused');
    expect(outcome.consumesAttempt).toBe(false);
    expect(outcome.retryable).toBe(true);
  });

  it('treats a policy denial as a refusal, not as work performed', () => {
    const outcome = classifyDelegationOutcome({
      error: new OrchestrationGuardViolation('Researcher already ran for this request; use its handoff.'),
    });

    expect(outcome.kind).toBe('refused');
    expect(outcome.consumesAttempt).toBe(false);
  });

  it('never spends an attempt when the delegation ended with nothing at all', () => {
    const outcome = classifyDelegationOutcome({});

    expect(outcome.consumesAttempt).toBe(false);
    expect(outcome.reason).toContain('without an artifact');
  });

  it('reads an unrecognized artifact status as no decision at all', () => {
    expect(classifyDelegationOutcome({ artifactStatus: 'thinking' }).consumesAttempt).toBe(false);
  });

  it('ignores casing and padding in the artifact status', () => {
    expect(classifyDelegationOutcome({ artifactStatus: '  READY ' }).kind).toBe('decided');
  });
});
