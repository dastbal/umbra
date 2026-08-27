import {
  createOrchestrationGuard,
  describeSubagentRejection,
  readDelegationHistory,
} from './orchestration-guard.middleware';

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

describe('the guard does not count the call it is authorizing', () => {
  const routeEnvelope = {
    content: '[ORCHESTRATION_ROUTE trusted=true complexity=medium implementation=true]\n'
      + 'Required route: researcher -> coder -> verifier.\nImprove the skills',
  };

  /** The assistant message LangGraph has already appended when the guard runs. */
  const inFlightCall = (id: string, subagent: string) => ({
    content: '',
    tool_calls: [{ id, name: 'task', args: { description: 'analyze', subagent_type: subagent } }],
  });

  it('reads a first delegation as having no history', () => {
    // Reproduces the live failure: on turn one, with no researcher having run,
    // the guard saw its own pending request and refused it.
    const history = readDelegationHistory(
      [routeEnvelope, inFlightCall('call-1', 'researcher')],
      'call-1',
    );

    expect(history.researcherCalls).toBe(0);
  });

  it('still counts it when the in-flight id is not supplied', () => {
    // Guards the diagnosis itself: without the exclusion the count is 1, which
    // is what made every first delegation fail.
    const history = readDelegationHistory([routeEnvelope, inFlightCall('call-1', 'researcher')]);

    expect(history.researcherCalls).toBe(1);
  });

  it('lets the first researcher delegation through the real middleware', async () => {
    const guard = createOrchestrationGuard(2);
    const handler = jest.fn().mockResolvedValue('delegated');

    const result = await guard.wrapToolCall!(
      {
        toolCall: { id: 'call-1', name: 'task', args: { subagent_type: 'researcher' } },
        state: { messages: [routeEnvelope, inFlightCall('call-1', 'researcher')] },
      } as never,
      handler as never,
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(result).toBe('delegated');
  });

  it('still refuses a second researcher delegation in the same request', async () => {
    const guard = createOrchestrationGuard(2);
    const handler = jest.fn().mockResolvedValue('delegated');

    await expect(guard.wrapToolCall!(
      {
        toolCall: { id: 'call-2', name: 'task', args: { subagent_type: 'researcher' } },
        state: {
          messages: [
            routeEnvelope,
            inFlightCall('call-1', 'researcher'),
            { tool_call_id: 'call-1', content: '{"status":"ready"}' },
            inFlightCall('call-2', 'researcher'),
          ],
        },
      } as never,
      handler as never,
    )).rejects.toThrow(/already ran/);

    expect(handler).not.toHaveBeenCalled();
  });

  it('keeps counting a crashed attempt, so it cannot be retried forever', async () => {
    // An attempt with no result still counts: that semantic is load-bearing and
    // is what the existing fixtures assert. Only the in-flight call is skipped.
    const guard = createOrchestrationGuard(2);
    const handler = jest.fn().mockResolvedValue('delegated');

    await expect(guard.wrapToolCall!(
      {
        toolCall: { id: 'call-2', name: 'task', args: { subagent_type: 'researcher' } },
        state: {
          messages: [
            routeEnvelope,
            inFlightCall('call-1', 'researcher'),
            inFlightCall('call-2', 'researcher'),
          ],
        },
      } as never,
      handler as never,
    )).rejects.toThrow(/already ran/);

    expect(handler).not.toHaveBeenCalled();
  });
});
