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
  // Stands in for a real suspension: interrupt() throws to suspend and, on
  // resume, returns the operator's answer. Measured 2026-08-27 to work inside a
  // nested subagent graph, which this project had wrongly believed impossible.
  interrupt: (request: unknown) => {
    interruptCalls.push(request);
    return interruptReply;
  },
}));

const interruptCalls: unknown[] = [];
let interruptReply: unknown;

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
    interruptCalls.length = 0;
    interruptReply = { answer: 'solo el contenido, no el cargador' };
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

  it('reaches the operator when the order does not cover the question', async () => {
    // Reversed on purpose, 2026-08-27. This path shipped disabled on the belief
    // that a subagent cannot suspend. It can: interrupt() reads its context
    // from async-local-storage, which inside a nested invoke still carries the
    // parent's checkpointer. What was broken was the CLI never rendering the
    // suspension — see presentation/cli/pending-interrupts.ts.
    openDelegation();

    const answer = await ask('Which TypeScript compiler version does the build target?');

    expect(interruptCalls).toHaveLength(1);
    expect(answer).toBe('solo el contenido, no el cargador');
  });

  it('marks the question as a question, never as an approval to act', async () => {
    openDelegation();
    await ask('Which TypeScript compiler version does the build target?');

    expect(interruptCalls[0]).toMatchObject({ kind: 'delegate_question' });
  });

  it('tells the delegate plainly when the operator declines to answer', async () => {
    interruptReply = undefined;
    openDelegation();

    const answer = await ask('Which TypeScript compiler version does the build target?');

    // A cancelled prompt is not an answer, and must never read as one.
    expect(answer).toContain('The operator did not answer');
    expect(answer).toContain('unknowns');
  });

  it('reports having nobody to ask when no delegation is running', async () => {
    openTurn('thread-ask', 'turn-1', 50);

    const answer = await ask('Anything at all?');

    expect(answer).toContain('nobody to ask');
  });

  it('lets an operator who finds it intrusive turn the escalation off', async () => {
    // The mandate half keeps working either way; only the interruption stops.
    process.env['UMBRA_SUBAGENT_QUESTIONS'] = '0';
    openDelegation();

    const answer = await ask('Which TypeScript compiler version does the build target?');

    expect(interruptCalls).toHaveLength(0);
    expect(answer).toContain('unknowns');
  });
});
