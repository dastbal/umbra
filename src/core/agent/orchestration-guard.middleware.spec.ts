import { GraphInterrupt } from '@langchain/langgraph';
import {
  createOrchestrationGuard,
  describeSubagentRejection,
  readDelegationHistory,
  readTurnKey,
} from './orchestration-guard.middleware';
import { currentTurn, resetDelegationRegistry } from './delegation/delegation-registry';

/** A delegation as it now reaches the guard: the order is the arguments. */
const order = {
  userRequest: 'crear un modulo de calculadora please',
  objective: 'Create a NestJS calculator module following the project patterns.',
  knownContext: ['The project follows DDD with four layers.'],
  inScope: ['A new module under src/'],
  outOfScope: ['The existing payment module.'],
  definitionOfDone: 'A research artifact describing the files to create.',
  conventions: ['Controllers return DTOs, never entities.'],
};

const call = (id: string, subagent: string, args: Record<string, unknown> = order) => ({
  content: '',
  tool_calls: [{ id, name: 'delegate', args: { subagent, ...args } }],
});

describe('readDelegationHistory', () => {
  it('uses only events after the latest interactive route envelope', () => {
    const history = readDelegationHistory([
      {
        content: '[ORCHESTRATION_ROUTE trusted=true complexity=large implementation=true]\nOld request',
      },
      call('old', 'researcher'),
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
      call('research', 'researcher'),
      { tool_call_id: 'research', content: '{"status":"ready"}' },
      call('coder', 'coder'),
      { tool_call_id: 'coder', content: '{"status":"ready"}' },
      call('verify', 'verifier'),
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
      call('research', 'researcher'),
      { tool_call_id: 'research', content: '{"status":"ready"}' },
      call('verify', 'verifier'),
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
      call('r', 'Researcher'),
      { tool_call_id: 'r', content: '{"status":"ready"}' },
      call('c', 'Coder'),
      { tool_call_id: 'c', content: '{"status":"ready"}' },
    ]);

    expect(history.researcherCalls).toBe(1);
    expect(history.coderCalls).toBe(1);
  });
});

describe('describeSubagentRejection', () => {
  // Retained from ADR-013. The provider now validates `subagent` before the
  // guard runs, so this message is unreachable through a declared call — it
  // survives for a caller that bypasses the declaration, and because a wrong
  // diagnosis once sent a real investigation to the wrong place.
  it('names the missing argument instead of blaming the subagent', () => {
    const message = describeSubagentRejection({ context: 'analyze', name: 'researcher', agent: 'researcher' });

    expect(message).toContain("no 'subagent' argument");
    expect(message).toContain('keys received: context, name, agent');
    expect(message).not.toContain('unregistered subagent');
  });

  it('names the value when a subagent is genuinely not allowed', () => {
    const message = describeSubagentRejection({ subagent: 'deployer' });

    expect(message).toContain("unregistered subagent 'deployer'");
    expect(message).toContain('researcher, coder, verifier');
  });

  it('handles a call with no arguments object at all', () => {
    expect(describeSubagentRejection(undefined)).toContain('no arguments object');
  });
});

describe('the guard at the moment of delegation', () => {
  const LIMITS = { maxRetries: 2, maxAgentTurns: 50 };

  const routeEnvelope = {
    content: '[ORCHESTRATION_ROUTE trusted=true complexity=medium implementation=true]\n'
      + 'Required route: researcher -> coder -> verifier.\nCreate a calculator module',
  };

  const requestFor = (
    id: string,
    subagent: string,
    messages: unknown[],
    args: Record<string, unknown> = order,
  ) => ({
    toolCall: { id, name: 'delegate', args: { subagent, ...args } },
    state: { messages },
    runtime: { configurable: { thread_id: 'thread-guard' } },
  });

  beforeEach(() => resetDelegationRegistry());

  it('reads a first delegation as having no history', () => {
    // Reproduces the live failure: on turn one, with no researcher having run,
    // the guard saw its own pending request and refused it.
    const history = readDelegationHistory(
      [routeEnvelope, call('call-1', 'researcher')],
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
      call('call-1', 'researcher'),
      { tool_call_id: 'call-1', content: '{"status":"ready"}' },
    ]);

    expect(history.researcherCalls).toBe(1);
  });

  it('lets the first researcher delegation through the real middleware', async () => {
    const guard = createOrchestrationGuard(LIMITS);
    const handler = jest.fn().mockResolvedValue('delegated');

    const result = await guard.wrapToolCall!(
      requestFor('call-1', 'researcher', [routeEnvelope, call('call-1', 'researcher')]) as never,
      handler as never,
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(result).toBe('delegated');
  });

  it('allows an explicitly registered advisory role without making it part of the writer lifecycle', async () => {
    const guard = createOrchestrationGuard({
      ...LIMITS,
      advisoryRoleIds: ['security-reviewer'],
    });
    const handler = jest.fn().mockResolvedValue('advice');

    const result = await guard.wrapToolCall!(
      requestFor('call-advice', 'security-reviewer', [routeEnvelope, call('call-advice', 'security-reviewer')]) as never,
      handler as never,
    );

    expect(result).toBe('advice');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('records the order and the grant where the delegation tool will find them', async () => {
    // The guard decides; the tool dispatches. The mandate is how one reaches
    // the other, since a tool sees arguments and never the ledger.
    const guard = createOrchestrationGuard(LIMITS);

    await guard.wrapToolCall!(
      requestFor('call-1', 'researcher', [routeEnvelope, call('call-1', 'researcher')]) as never,
      jest.fn().mockImplementation(async () => {
        const ledger = currentTurn('thread-guard')!;
        const mandate = ledger.mandates.get(ledger.activeDelegationId!);

        expect(mandate?.userRequest).toBe(order.userRequest);
        expect(mandate?.budget.toolCalls).toBe(14);
        return 'delegated';
      }) as never,
    );
  });

  it('still refuses a second researcher delegation in the same request', async () => {
    const guard = createOrchestrationGuard(LIMITS);
    const handler = jest.fn().mockResolvedValue('delegated');

    await expect(guard.wrapToolCall!(
      requestFor('call-2', 'researcher', [
        routeEnvelope,
        call('call-1', 'researcher'),
        { tool_call_id: 'call-1', content: '{"status":"ready"}' },
        call('call-2', 'researcher'),
      ]) as never,
      handler as never,
    )).rejects.toThrow(/already ran/);

    expect(handler).not.toHaveBeenCalled();
  });

  it('lets a crashed attempt be tried again, because nothing was decided', async () => {
    // Reversed on purpose, 2026-08-27. The earlier rule counted every request,
    // so a Researcher killed by the recursion limit had spent the turn's only
    // researcher slot and the orchestrator was told "already ran" with no
    // research in hand. Runaway retries are held by the budget pool, which
    // charges every attempt to the same turn allowance.
    const guard = createOrchestrationGuard(LIMITS);
    const handler = jest.fn().mockResolvedValue('delegated');

    await guard.wrapToolCall!(
      requestFor('call-2', 'researcher', [
        routeEnvelope,
        call('call-1', 'researcher'),
        call('call-2', 'researcher'),
      ]) as never,
      handler as never,
    );

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('refuses an order that carries nothing to act on, without ending the turn', async () => {
    // The schema makes the fields present. Whether `objective` says anything is
    // what remains for the guard, and it is handed back to be rewritten.
    const guard = createOrchestrationGuard(LIMITS);
    const handler = jest.fn().mockResolvedValue('delegated');
    const empty = { ...order, objective: '   ', knownContext: [] };

    const result = await guard.wrapToolCall!(
      requestFor('call-1', 'researcher', [routeEnvelope, call('call-1', 'researcher', empty)], empty) as never,
      handler as never,
    );

    expect(handler).not.toHaveBeenCalled();
    expect(String((result as { content: string }).content)).toContain('objective');
    expect(String((result as { content: string }).content)).toContain('delegate call');
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
      requestFor('call-1', 'researcher', [routeEnvelope, call('call-1', 'researcher')]) as never,
      handler as never,
    );
    const second = await guard.wrapToolCall!(
      requestFor('call-2', 'researcher', [routeEnvelope, call('call-2', 'researcher')]) as never,
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

  const requestFor = (id: string, messages: unknown[]) => ({
    toolCall: { id, name: 'delegate', args: { subagent: 'researcher', ...order } },
    state: { messages },
    runtime: { configurable: { thread_id: 'thread-suspend' } },
  });

  beforeEach(() => resetDelegationRegistry());

  it('keeps the delegation open when the run suspends to ask the operator', async () => {
    // interrupt() suspends by throwing. Closing the delegation here would leave
    // the resumed tool body with no delegation to belong to, and ask_delegator
    // would answer that no delegation context is active.
    const guard = createOrchestrationGuard(LIMITS);
    const suspend = jest.fn().mockRejectedValue(new GraphInterrupt([]));

    await expect(guard.wrapToolCall!(
      requestFor('call-1', [routeEnvelope, call('call-1', 'researcher')]) as never,
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
      requestFor('call-1', [routeEnvelope, call('call-1', 'researcher')]) as never,
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
      requestFor('call-1', [routeEnvelope, call('call-1', 'researcher')]) as never,
      handler as never,
    );

    expect(currentTurn('thread-suspend')?.activeDelegationId).toBeUndefined();
  });
});
