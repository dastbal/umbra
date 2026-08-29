import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import { createDelegateTool } from './delegate.tool';
import {
  currentTurn,
  openTurn,
  recordFinding,
  resetDelegationRegistry,
} from './delegation-registry';
import type { Mandate } from './mandate';

jest.mock('@langchain/langgraph', () => ({
  ...jest.requireActual('@langchain/langgraph'),
  getConfig: () => ({
    configurable: { thread_id: 'thread-delegate' },
    toolCall: { id: 'call-1' },
  }),
  getCurrentTaskInput: () => parentState,
}));

let parentState: unknown;

const mandate: Mandate = {
  userRequest: 'crear un modulo de calculadora please',
  objective: 'Create a NestJS calculator module.',
  knownContext: ['The project follows DDD with four layers.'],
  inScope: ['A new module under src/'],
  outOfScope: ['The existing payment module.'],
  definitionOfDone: 'A research artifact.',
  conventions: [],
  budget: { toolCalls: 14, questions: 2 },
};

const order = {
  subagent: 'researcher' as const,
  userRequest: mandate.userRequest,
  objective: mandate.objective,
  knownContext: mandate.knownContext,
  inScope: mandate.inScope,
  definitionOfDone: mandate.definitionOfDone,
};

function openDelegation(): void {
  const ledger = openTurn('thread-delegate', 'turn-1', 50);
  ledger.mandates.set('researcher#1', mandate);
  ledger.activeDelegationId = 'researcher#1';
}

function graphsReturning(result: unknown) {
  const invoke = jest.fn().mockResolvedValue(result);
  return {
    graphs: { researcher: { invoke }, coder: { invoke }, verifier: { invoke } },
    invoke,
  };
}

function advisoryGraphsReturning(result: unknown) {
  const invoke = jest.fn().mockResolvedValue(result);
  return {
    graphs: {
      researcher: { invoke }, coder: { invoke }, verifier: { invoke }, 'security-reviewer': { invoke },
    },
    invoke,
  };
}

const run = (input: unknown, tool: ReturnType<typeof createDelegateTool>): Promise<unknown> =>
  (tool as unknown as { invoke(value: unknown): Promise<unknown> }).invoke(input);

describe('the delegate schema', () => {
  const declared = convertToOpenAITool(
    createDelegateTool(graphsReturning({}).graphs as never) as never,
  ).function;

  it('requires exactly the fields a delegate cannot recover by working harder', () => {
    // The interlocking: a delegation missing any of these is refused by the
    // provider at the function-calling layer, not diagnosed by us afterwards.
    expect((declared.parameters as { required: string[] }).required.sort()).toEqual(
      ['definitionOfDone', 'inScope', 'knownContext', 'objective', 'subagent', 'userRequest'],
    );
  });

  it('leaves the boundary fields optional, so none is ever invented', () => {
    const required = (declared.parameters as { required: string[] }).required;

    expect(required).not.toContain('outOfScope');
    expect(required).not.toContain('conventions');
  });

  it('carries no union, which the provider would reject', () => {
    // Verified the same way the researcher tools were before shipping.
    expect(JSON.stringify(declared.parameters)).not.toMatch(/anyOf|oneOf|allOf/);
  });

  it('makes the flattened order the shape, so flattening cannot be a mistake', () => {
    const properties = Object.keys((declared.parameters as { properties: object }).properties);

    expect(properties).toContain('userRequest');
    expect(properties).toContain('subagent');
    expect(properties).not.toContain('description');
  });
});

describe('delegate', () => {
  beforeEach(() => {
    resetDelegationRegistry();
    parentState = { files: { 'src/app.ts': 'export const app = 1;' }, messages: ['secret'] };
  });

  it('hands the delegate its order as prose, not as the arguments it arrived in', async () => {
    openDelegation();
    const { graphs, invoke } = graphsReturning({ messages: [{ content: 'done' }] });

    await run(order, createDelegateTool(graphs as never));

    const delivered = String((invoke.mock.calls[0][0] as { messages: { content: string }[] }).messages[0].content);

    expect(delivered).toContain(mandate.userRequest);
    expect(delivered).toContain('Out of scope');
    expect(delivered).toContain('14 tool attempts');
  });

  it('shares the workspace with the delegate and never the conversation', async () => {
    openDelegation();
    const { graphs, invoke } = graphsReturning({ messages: [{ content: 'done' }] });

    await run(order, createDelegateTool(graphs as never));

    const state = invoke.mock.calls[0][0] as Record<string, unknown>;

    expect(state['files']).toEqual({ 'src/app.ts': 'export const app = 1;' });
    expect(JSON.stringify(state['messages'])).not.toContain('secret');
  });

  it('dispatches to the delegate the order names', async () => {
    openDelegation();
    const { graphs } = graphsReturning({ messages: [{ content: 'done' }] });
    const tool = createDelegateTool(graphs as never);

    await run({ ...order, subagent: 'coder' }, tool);

    expect((graphs.coder.invoke as jest.Mock)).toHaveBeenCalled();
  });

  it('dispatches a registered advisory role without widening the core schema by hand', async () => {
    const ledger = openTurn('thread-delegate', 'turn-1', 50);
    ledger.mandates.set('security-reviewer#1', mandate);
    ledger.activeDelegationId = 'security-reviewer#1';
    const { graphs, invoke } = advisoryGraphsReturning({ messages: [{ content: 'done' }] });

    await run({ ...order, subagent: 'security-reviewer' }, createDelegateTool(graphs as never));

    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('returns the artifact so the policy can read its status', async () => {
    openDelegation();
    const artifact = { status: 'ready', objective: 'x', findings: [] };
    const { graphs } = graphsReturning({ structuredResponse: artifact });

    const result = await run(order, createDelegateTool(graphs as never)) as { update: { messages: { content: string }[] } };

    expect(JSON.parse(result.update.messages[0].content)).toEqual(artifact);
  });

  it('merges the delegate workspace back into the orchestrator', async () => {
    openDelegation();
    const { graphs } = graphsReturning({
      files: { 'src/new.ts': 'export const x = 1;' },
      messages: [{ content: 'done' }],
    });

    const result = await run(order, createDelegateTool(graphs as never)) as { update: Record<string, unknown> };

    expect(result.update['files']).toEqual({ 'src/new.ts': 'export const x = 1;' });
  });

  it('passes what earlier delegates established to the next one', async () => {
    openDelegation();
    recordFinding(currentTurn('thread-delegate')!, 'skills/ holds six markdown guides');
    const { graphs, invoke } = graphsReturning({ messages: [{ content: 'done' }] });

    await run(order, createDelegateTool(graphs as never));

    expect(String((invoke.mock.calls[0][0] as { messages: { content: string }[] }).messages[0].content))
      .toContain('skills/ holds six markdown guides');
  });

  it('refuses to dispatch when the guard authorized no delegation', async () => {
    openTurn('thread-delegate', 'turn-1', 50);
    const { graphs, invoke } = graphsReturning({});

    const result = await run(order, createDelegateTool(graphs as never));

    expect(invoke).not.toHaveBeenCalled();
    expect(String(result)).toContain('nobody to delegate to');
  });

  it('refuses to dispatch a delegation whose order was never recorded', async () => {
    const ledger = openTurn('thread-delegate', 'turn-1', 50);
    ledger.activeDelegationId = 'researcher#1';
    const { graphs, invoke } = graphsReturning({});

    const result = await run(order, createDelegateTool(graphs as never));

    expect(invoke).not.toHaveBeenCalled();
    expect(String(result)).toContain('no recorded order');
  });
});
