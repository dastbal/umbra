import { describeSubagentRejection, readDelegationHistory } from './orchestration-guard.middleware';

describe('readDelegationHistory', () => {
  it('uses only events after the latest interactive route envelope', () => {
    const history = readDelegationHistory([
      {
        content: '[ORCHESTRATION_ROUTE trusted=true complexity=large implementation=true]\nOld request',
      },
      { tool_calls: [{ name: 'task', args: { subagent_type: 'researcher' } }] },
      {
        content: '[ORCHESTRATION_ROUTE trusted=true complexity=small implementation=false]\nNew question',
      },
    ]);

    expect(history.routeRequiresImplementation).toBe(false);
    expect(history.researcherCalls).toBe(0);
  });

  it('recovers delegation attempts and verifier artifacts from checkpoint messages', () => {
    const history = readDelegationHistory([
      {
        content: '[ORCHESTRATION_ROUTE trusted=true complexity=large implementation=true]\nImplement feature',
      },
      { tool_calls: [{ id: 'research', name: 'task', args: { subagent_type: 'researcher' } }] },
      { tool_call_id: 'research', content: '{"status":"ready"}' },
      { tool_calls: [{ id: 'coder', name: 'task', args: { subagent_type: 'coder' } }] },
      { tool_calls: [{ id: 'verify', name: 'task', args: { subagent_type: 'verifier' } }] },
      { tool_call_id: 'verify', content: '{"status":"failed","testsPassed":false}' },
    ]);

    expect(history.researcherCalls).toBe(1);
    expect(history.coderCalls).toBe(1);
    expect(history.verifierResults).toEqual(['failed']);
    expect(history.researcherReady).toBe(true);
    expect(history.researcherBlocked).toBe(false);
  });

  it('does not mistake a blocked verifier artifact for a blocked researcher handoff', () => {
    const history = readDelegationHistory([
      {
        content: '[ORCHESTRATION_ROUTE trusted=true complexity=large implementation=true]\nImplement feature',
      },
      { tool_calls: [{ id: 'research', name: 'task', args: { subagent_type: 'researcher' } }] },
      { tool_call_id: 'research', content: '{"status":"ready"}' },
      { tool_calls: [{ id: 'verify', name: 'task', args: { subagent_type: 'verifier' } }] },
      { tool_call_id: 'verify', content: '{"status":"blocked"}' },
    ]);

    expect(history.researcherReady).toBe(true);
    expect(history.researcherBlocked).toBe(false);
    expect(history.verifierResults).toEqual(['blocked']);
  });

  it('normalizes title-cased subagent names emitted by the Supervisor', () => {
    const history = readDelegationHistory([
      {
        content: '[ORCHESTRATION_ROUTE trusted=true complexity=large implementation=true]\nImplement feature',
      },
      { tool_calls: [{ name: 'task', args: { subagent_type: 'Researcher' } }] },
      { tool_calls: [{ name: 'task', args: { subagent_type: 'Coder' } }] },
      { tool_calls: [{ name: 'task', args: { subagent_type: 'Verifier' } }] },
    ]);

    expect(history.researcherCalls).toBe(1);
    expect(history.coderCalls).toBe(1);
  });
});

describe('describeSubagentRejection', () => {
  it('names the missing argument instead of blaming the subagent', () => {
    // The real failure: the model asked for researcher under the wrong key,
    // because the task declaration never reached the provider (ADR-013).
    const message = describeSubagentRejection({ context: 'analyze', name: 'researcher', agent: 'researcher' });

    expect(message).toContain("no 'subagent_type' argument");
    expect(message).toContain('keys received: context, name, agent');
    expect(message).not.toContain('unregistered subagent');
  });

  it('names the value when a subagent is genuinely not allowed', () => {
    const message = describeSubagentRejection({ subagent_type: 'deployer' });

    expect(message).toContain("unregistered subagent 'deployer'");
    expect(message).toContain('researcher, coder, and verifier');
  });

  it('produces different messages for the two causes', () => {
    expect(describeSubagentRejection({ agent: 'researcher' }))
      .not.toBe(describeSubagentRejection({ subagent_type: 'deployer' }));
  });

  it('handles a call with no arguments object at all', () => {
    expect(describeSubagentRejection(undefined)).toContain('no arguments object');
  });

  it('treats a blank subagent_type as missing, not as an unknown name', () => {
    expect(describeSubagentRejection({ subagent_type: '   ' })).toContain("no 'subagent_type' argument");
  });
});
