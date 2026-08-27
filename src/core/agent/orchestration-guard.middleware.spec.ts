import {
  createOrchestrationGuard,
  describeSubagentRejection,
  readDelegationHistory,
  readTurnKey,
} from './orchestration-guard.middleware';
import { currentTurn, resetDelegationRegistry } from './delegation/delegation-registry';
import { GraphInterrupt } from '@langchain/langgraph';

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
      { tool_call_id: 'coder', content: '{"status":"ready"}' },
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


describe('the guard at the moment of delegation', () => {
  const LIMITS = { maxRetries: 2, maxAgentTurns: 50 };

  const routeEnvelope = {
    content: '[ORCHESTRATION_ROUTE trusted=true complexity=medium implementation=true]\n'
      + 'Required route: researcher -> coder -> verifier.\nImprove the skills',
  };

  const order = {
    userRequest: 'quiero que mejores los skills tuyos y me sugieras cambios',
    objective: 'Review every guide under skills/ and propose concrete changes.',
    knownContext: ['The route is medium complexity and permits implementation.'],
    inScope: ['The markdown guides under skills/'],
    outOfScope: ['The general architecture of the project, which is settled.'],
    definitionOfDone: 'A research artifact listing each skill and its proposed change.',
    conventions: ['Everything written into the repository is in English.'],
  };

  /** The assistant message LangGraph has already appended when the guard runs. */
  const inFlightCall = (id: string, subagent: string, description: unknown = JSON.stringify(order)) => ({
    content: '',
    tool_calls: [{ id, name: 'task', args: { description, subagent_type: subagent } }],
  });

  const requestFor = (
    id: string,
    subagent: string,
    messages: unknown[],
    description: unknown = JSON.stringify(order),
  ) => ({
    toolCall: { id, name: 'task', args: { description, subagent_type: subagent } },
    state: { messages },
    runtime: { configurable: { thread_id: 'thread-guard' } },
  });

  beforeEach(() => resetDelegationRegistry());

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
    // is what made every first delegation fail. The result message is what makes
    // this a decided attempt at all — a delegation that returned nothing decided
    // nothing and no longer counts.
    const history = readDelegationHistory([
      routeEnvelope,
      inFlightCall('call-1', 'researcher'),
      { tool_call_id: 'call-1', content: '{"status":"ready"}' },
    ]);

    expect(history.researcherCalls).toBe(1);
  });

  it('lets the first researcher delegation through the real middleware', async () => {
    const guard = createOrchestrationGuard(LIMITS);
    const handler = jest.fn().mockResolvedValue('delegated');

    const result = await guard.wrapToolCall!(
      requestFor('call-1', 'researcher', [routeEnvelope, inFlightCall('call-1', 'researcher')]) as never,
      handler as never,
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(result).toBe('delegated');
  });

  it('still refuses a second researcher delegation in the same request', async () => {
    const guard = createOrchestrationGuard(LIMITS);
    const handler = jest.fn().mockResolvedValue('delegated');

    await expect(guard.wrapToolCall!(
      requestFor('call-2', 'researcher', [
        routeEnvelope,
        inFlightCall('call-1', 'researcher'),
        { tool_call_id: 'call-1', content: '{"status":"ready"}' },
        inFlightCall('call-2', 'researcher'),
      ]) as never,
      handler as never,
    )).rejects.toThrow(/already ran/);

    expect(handler).not.toHaveBeenCalled();
  });

  it('lets a crashed attempt be tried again, because nothing was decided', async () => {
    // Reversed on purpose, 2026-08-27. The earlier rule counted every request,
    // so a Researcher killed by the recursion limit had spent the turn's only
    // researcher slot and the orchestrator was told "already ran" with no
    // research in hand. Runaway retries are now held by the budget pool, which
    // charges every attempt to the same turn allowance.
    const guard = createOrchestrationGuard(LIMITS);
    const handler = jest.fn().mockResolvedValue('delegated');

    await guard.wrapToolCall!(
      requestFor('call-2', 'researcher', [
        routeEnvelope,
        inFlightCall('call-1', 'researcher'),
        inFlightCall('call-2', 'researcher'),
      ]) as never,
      handler as never,
    );

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('refuses an order that carries no context, without ending the turn', async () => {
    // The impoverished order that caused the sweep: the delegate would have
    // received a micro-task and never seen what the user actually asked.
    const guard = createOrchestrationGuard(LIMITS);
    const handler = jest.fn().mockResolvedValue('delegated');
    const poorDescription = 'List all files in the skills/ directory';

    const result = await guard.wrapToolCall!(
      requestFor(
        'call-1',
        'researcher',
        [routeEnvelope, inFlightCall('call-1', 'researcher', poorDescription)],
        poorDescription,
      ) as never,
      handler as never,
    );

    expect(handler).not.toHaveBeenCalled();
    expect(String((result as { content: string }).content)).toContain('userRequest');
  });

  it('hands the delegate prose, not the json the orchestrator wrote', async () => {
    const guard = createOrchestrationGuard(LIMITS);
    const handler = jest.fn().mockResolvedValue('delegated');

    await guard.wrapToolCall!(
      requestFor('call-1', 'researcher', [routeEnvelope, inFlightCall('call-1', 'researcher')]) as never,
      handler as never,
    );

    const delivered = handler.mock.calls[0][0].toolCall.args.description as string;

    expect(delivered).toContain('request, verbatim');
    expect(delivered).toContain(order.userRequest);
    expect(delivered).toContain('Out of scope');
    expect(delivered).not.toContain('"userRequest"');
  });

  it('tells the delegate how much budget it was granted', async () => {
    const guard = createOrchestrationGuard(LIMITS);
    const handler = jest.fn().mockResolvedValue('delegated');

    await guard.wrapToolCall!(
      requestFor('call-1', 'researcher', [routeEnvelope, inFlightCall('call-1', 'researcher')]) as never,
      handler as never,
    );

    expect(handler.mock.calls[0][0].toolCall.args.description).toContain('14 tool attempts');
  });

  it('carries the findings of one delegate into the order of the next', async () => {
    const guard = createOrchestrationGuard(LIMITS);
    const researcher = jest.fn().mockResolvedValue(
      '{"status":"ready","findings":["skills/ holds six markdown guides"]}',
    );
    const coder = jest.fn().mockResolvedValue('done');

    await guard.wrapToolCall!(
      requestFor('call-1', 'researcher', [routeEnvelope, inFlightCall('call-1', 'researcher')]) as never,
      researcher as never,
    );
    await guard.wrapToolCall!(
      requestFor('call-2', 'coder', [
        routeEnvelope,
        inFlightCall('call-1', 'researcher'),
        { tool_call_id: 'call-1', content: '{"status":"ready"}' },
        inFlightCall('call-2', 'coder'),
      ]) as never,
      coder as never,
    );

    expect(coder.mock.calls[0][0].toolCall.args.description)
      .toContain('skills/ holds six markdown guides');
  });

  it('stops delegating once only the reserve is left', async () => {
    const guard = createOrchestrationGuard({ maxRetries: 2, maxAgentTurns: 2 });
    const handler = jest.fn().mockImplementation(async () => {
      // Stands in for the subagent budget middleware: the delegate spends what
      // it was granted, so nothing is released back to the pool.
      const ledger = currentTurn('thread-guard')!;
      const delegationId = ledger.activeDelegationId!;
      while (!ledger.pool.isExhausted(delegationId)) ledger.pool.consume(delegationId);
      return 'delegated';
    });

    await guard.wrapToolCall!(
      requestFor('call-1', 'researcher', [routeEnvelope, inFlightCall('call-1', 'researcher')]) as never,
      handler as never,
    );
    const second = await guard.wrapToolCall!(
      requestFor('call-2', 'researcher', [routeEnvelope, inFlightCall('call-2', 'researcher')]) as never,
      handler as never,
    );

    expect(String((second as { content: string }).content)).toMatch(/budget|reserve/i);
  });

  it('scopes the budget to one turn of one thread', () => {
    const firstTurn = readTurnKey([routeEnvelope]);
    const secondTurn = readTurnKey([
      routeEnvelope,
      { type: 'human', content: 'another instruction' },
      { content: '[ORCHESTRATION_ROUTE trusted=true complexity=small implementation=true]\nnext' },
    ]);

    expect(firstTurn).not.toBe(secondTurn);
  });
});

describe('a suspended delegation is paused, not finished', () => {
  const LIMITS = { maxRetries: 2, maxAgentTurns: 50 };

  const routeEnvelope = {
    content: '[ORCHESTRATION_ROUTE trusted=true complexity=medium implementation=true]\n'
      + 'Required route: researcher -> coder -> verifier.\nAsk a subagent how it is',
  };

  const order = {
    userRequest: 'puede preguntarle a un subagente como esta please',
    objective: 'Determine how a status check could be implemented.',
    knownContext: ['The route permits implementation.'],
    inScope: ['The subagent definitions'],
    outOfScope: [],
    definitionOfDone: 'A research artifact.',
    conventions: [],
  };

  const requestFor = (id: string, messages: unknown[]) => ({
    toolCall: { id, name: 'task', args: { description: JSON.stringify(order), subagent_type: 'researcher' } },
    state: { messages },
    runtime: { configurable: { thread_id: 'thread-suspend' } },
  });

  const inFlightCall = (id: string) => ({
    content: '',
    tool_calls: [{ id, name: 'task', args: { description: JSON.stringify(order), subagent_type: 'researcher' } }],
  });

  beforeEach(() => resetDelegationRegistry());

  it('keeps the delegation open when the run suspends to ask the operator', async () => {
    // interrupt() suspends by throwing. Closing the delegation here would leave
    // the resumed tool body with no delegation to belong to, and ask_delegator
    // would answer that no delegation context is active.
    const guard = createOrchestrationGuard(LIMITS);
    const suspend = jest.fn().mockRejectedValue(new GraphInterrupt([]));

    await expect(guard.wrapToolCall!(
      requestFor('call-1', [routeEnvelope, inFlightCall('call-1')]) as never,
      suspend as never,
    )).rejects.toBeDefined();

    const ledger = currentTurn('thread-suspend');

    expect(ledger?.activeDelegationId).toBe('researcher#1');
    expect(ledger?.pool.grantable).toBe(26);
  });

  it('closes the delegation for an ordinary failure', async () => {
    const guard = createOrchestrationGuard(LIMITS);
    const fail = jest.fn().mockRejectedValue(new Error('the provider rejected the request'));

    await expect(guard.wrapToolCall!(
      requestFor('call-1', [routeEnvelope, inFlightCall('call-1')]) as never,
      fail as never,
    )).rejects.toThrow('the provider rejected');

    const ledger = currentTurn('thread-suspend');

    expect(ledger?.activeDelegationId).toBeUndefined();
    expect(ledger?.pool.grantable).toBe(40);
  });

  it('closes the delegation when it completes normally', async () => {
    const guard = createOrchestrationGuard(LIMITS);
    const handler = jest.fn().mockResolvedValue('{"status":"ready"}');

    await guard.wrapToolCall!(
      requestFor('call-1', [routeEnvelope, inFlightCall('call-1')]) as never,
      handler as never,
    );

    expect(currentTurn('thread-suspend')?.activeDelegationId).toBeUndefined();
  });
});

describe('a model that flattens the order into the call', () => {
  const LIMITS = { maxRetries: 2, maxAgentTurns: 50 };

  const routeEnvelope = {
    content: '[ORCHESTRATION_ROUTE trusted=true complexity=medium implementation=true]\n'
      + 'Required route: researcher -> coder -> verifier.\nCreate a calculator module',
  };

  const orderFields = {
    userRequest: 'crear un modulo de calculadora please',
    objective: 'Create a NestJS calculator module following the project patterns.',
    knownContext: ['The project follows DDD with four layers.'],
    inScope: ['A new module under src/'],
    outOfScope: ['The existing payment module.'],
    definitionOfDone: 'A research artifact describing the files to create.',
    conventions: ['Controllers return DTOs, never entities.'],
  };

  const inFlightCall = (id: string, args: Record<string, unknown>) => ({
    content: '',
    tool_calls: [{ id, name: 'task', args }],
  });

  const requestFor = (id: string, args: Record<string, unknown>, messages: unknown[]) => ({
    toolCall: { id, name: 'task', args },
    state: { messages },
    runtime: { configurable: { thread_id: 'thread-flat' } },
  });

  beforeEach(() => resetDelegationRegistry());

  it('hands the call back instead of ending the turn when subagent_type is lost', async () => {
    // Observed live on 2026-08-27 with gemini-2.5-flash-lite. Flattening the
    // order into the call dropped subagent_type, and a thrown refusal killed
    // the session over a message the model only had to rewrite.
    const guard = createOrchestrationGuard(LIMITS);
    const handler = jest.fn();
    const flattened = { ...orderFields, description: 'Research the module' };

    const result = await guard.wrapToolCall!(
      requestFor('call-1', flattened, [routeEnvelope, inFlightCall('call-1', flattened)]) as never,
      handler as never,
    );

    const content = String((result as { content: string }).content);

    expect(handler).not.toHaveBeenCalled();
    expect(content).toContain('subagent_type');
    expect(content).toContain('exactly two arguments');
  });

  it('tells the model where the order fields belong', async () => {
    const guard = createOrchestrationGuard(LIMITS);
    const flattened = { ...orderFields, description: 'Research the module' };

    const result = await guard.wrapToolCall!(
      requestFor('call-1', flattened, [routeEnvelope, inFlightCall('call-1', flattened)]) as never,
      jest.fn() as never,
    );

    expect(String((result as { content: string }).content)).toContain('INSIDE the description string');
  });

  it('accepts an order written as arguments once the subagent is named', async () => {
    // The order itself was complete and correct; only its placement was wrong.
    // Refusing it over placement would be pedantry paid for by the operator.
    const guard = createOrchestrationGuard(LIMITS);
    const handler = jest.fn().mockResolvedValue('delegated');
    const flattened = { ...orderFields, subagent_type: 'researcher' };

    await guard.wrapToolCall!(
      requestFor('call-1', flattened, [routeEnvelope, inFlightCall('call-1', flattened)]) as never,
      handler as never,
    );

    const delivered = handler.mock.calls[0][0].toolCall.args.description as string;

    expect(handler).toHaveBeenCalledTimes(1);
    expect(delivered).toContain(orderFields.userRequest);
    expect(delivered).toContain('The existing payment module.');
  });

  it('accepts an order placed in description as an object rather than a string', async () => {
    const guard = createOrchestrationGuard(LIMITS);
    const handler = jest.fn().mockResolvedValue('delegated');
    const nested = { subagent_type: 'researcher', description: orderFields };

    await guard.wrapToolCall!(
      requestFor('call-1', nested, [routeEnvelope, inFlightCall('call-1', nested)]) as never,
      handler as never,
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].toolCall.args.description).toContain(orderFields.objective);
  });
});
