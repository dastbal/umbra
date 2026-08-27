import { askDelegatorTool } from './ask-delegator.tool';
import {
  openTurn,
  resetDelegationRegistry,
  type DelegationLedger,
} from '../../agent/delegation/delegation-registry';
import type { Mandate } from '../../agent/delegation/mandate';

jest.mock('@langchain/langgraph', () => ({
  ...jest.requireActual('@langchain/langgraph'),
  getConfig: () => ({ configurable: { thread_id: 'thread-ask' } }),
  interrupt: () => {
    throw new Error('interrupt() must not be reached while the channel is disabled');
  },
}));

const mandate: Mandate = {
  userRequest: 'puede preguntarle a un subagente como esta please',
  objective: 'Determine how a subagent status check could work.',
  knownContext: ['The orchestrator has already classified the route.'],
  inScope: ['The subagent definitions under src/core/subagents/'],
  outOfScope: ['The RAG index, which is out of scope for this delegation.'],
  definitionOfDone: 'A research artifact.',
  conventions: [],
  budget: { toolCalls: 14, questions: 2 },
};

function openDelegation(): DelegationLedger {
  const ledger = openTurn('thread-ask', 'turn-1', 50);
  ledger.mandates.set('researcher#1', mandate);
  ledger.activeDelegationId = 'researcher#1';
  return ledger;
}

/** Invokes the tool the way LangGraph does, without a graph around it. */
const ask = (question: string): Promise<string> =>
  (askDelegatorTool as unknown as { invoke(input: unknown): Promise<string> })
    .invoke({ question });

describe('ask_delegator', () => {
  const originalFlag = process.env['UMBRA_SUBAGENT_QUESTIONS'];

  beforeEach(() => {
    resetDelegationRegistry();
    delete process.env['UMBRA_SUBAGENT_QUESTIONS'];
  });

  afterAll(() => {
    if (originalFlag === undefined) delete process.env['UMBRA_SUBAGENT_QUESTIONS'];
    else process.env['UMBRA_SUBAGENT_QUESTIONS'] = originalFlag;
  });

  it('answers from the order without suspending anything', async () => {
    openDelegation();

    const answer = await ask('Is the RAG index in scope for this delegation?');

    expect(answer).toContain('out of scope');
    expect(answer).toContain('The RAG index, which is out of scope for this delegation.');
  });

  it('does not suspend the run when the order does not cover the question', async () => {
    // The live failure of 2026-08-27: a subagent graph has no checkpointer, so
    // interrupt() has nothing to resume from. The run stopped for 145 seconds
    // waiting for an operator who was never going to be asked. The mocked
    // interrupt above throws if this path is ever reached.
    openDelegation();

    const answer = await ask('Which TypeScript compiler version does the build target?');

    expect(answer).toContain('unknowns');
    expect(answer).not.toContain('must not be reached');
  });

  it('tells the delegate plainly that nothing was answered', async () => {
    openDelegation();

    const answer = await ask('Which TypeScript compiler version does the build target?');

    expect(answer).toContain('Do not treat this as an answer');
  });

  it('reports having nobody to ask when no delegation is running', async () => {
    openTurn('thread-ask', 'turn-1', 50);

    const answer = await ask('Anything at all?');

    expect(answer).toContain('nobody to ask');
  });

  it('keeps the escalation reachable behind the escape hatch', async () => {
    // The channel is disabled, not removed: whoever makes a subagent suspend
    // properly needs a way to exercise it. Mirrors UMBRA_SIMPLE_PROMPT=1.
    process.env['UMBRA_SUBAGENT_QUESTIONS'] = '1';
    openDelegation();

    await expect(ask('Which TypeScript compiler version does the build target?'))
      .resolves.toContain('unknowns');
  });
});
