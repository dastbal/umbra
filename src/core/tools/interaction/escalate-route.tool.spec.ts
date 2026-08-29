import { escalateRouteTool } from './escalate-route.tool';
import { readPromotion, resetLaneRegistry } from '../../agent/lane-registry';
import { readTurnKey } from '../../agent/orchestration-guard.middleware';

jest.mock('@langchain/langgraph', () => ({
  ...jest.requireActual('@langchain/langgraph'),
  getConfig: () => ({ configurable: { thread_id: 'thread-lane' } }),
  getCurrentTaskInput: () => ({ messages }),
}));

let messages: unknown[] = [];

const envelope = (lane: string) => ({
  content: `[ORCHESTRATION_ROUTE trusted=true complexity=small lane=${lane} implementation=${lane === 'change'}]\n`
    + 'User request (preserve intent exactly):\nel login esta roto',
});

const escalate = (reason: string): Promise<string> =>
  (escalateRouteTool as unknown as { invoke(input: unknown): Promise<string> }).invoke({ reason });

describe('escalate_route', () => {
  beforeEach(() => {
    resetLaneRegistry();
    messages = [envelope('read')];
  });

  it('raises a reading turn that discovered it must write', async () => {
    // The property that lets triage sort unrecognised requests down: the low
    // lane is not a dead end. "el login esta roto" starts in read because no
    // vocabulary matched it, and gets out by saying what it found.
    const answer = await escalate('The fix requires editing src/auth/login.service.ts.');

    expect(answer).toContain('raised to the change lane');
    expect(readPromotion('thread-lane', readTurnKey(messages))).toEqual({
      lane: 'change',
      reason: 'The fix requires editing src/auth/login.service.ts.',
    });
  });

  it('refuses to raise a message that asked for no work', async () => {
    // The rule that keeps a greeting from reaching the disk. No chain of
    // reasoning walks "maestro" up to a file write, because nothing in it asked.
    messages = [envelope('answer')];

    const answer = await escalate('I would like to add a test while I am here.');

    expect(answer).toContain('asked for no work');
    expect(readPromotion('thread-lane', readTurnKey(messages))).toBeUndefined();
  });

  it('allows one promotion per turn, so a model cannot climb lane by lane', async () => {
    await escalate('The fix requires a code change.');

    const second = await escalate('And now I would like to change something else.');

    expect(second).toContain('already been escalated');
  });

  it('refuses a promotion that gives no reason', async () => {
    const answer = await escalate('   ');

    expect(answer).toContain('needs a reason');
    expect(readPromotion('thread-lane', readTurnKey(messages))).toBeUndefined();
  });

  it('tells a turn already allowed to write that there is nothing to raise', async () => {
    messages = [envelope('change')];

    expect(await escalate('I need to write files.')).toContain('Already running in the change lane');
  });

  it('reports plainly when there is no route to act on', async () => {
    messages = [];

    expect(await escalate('anything')).toContain('no lane to raise');
  });

  it('reminds the agent to say out loud that it changed files', async () => {
    // A turn that quietly upgraded itself and then wrote is the failure this
    // whole mechanism exists to prevent being invisible.
    expect(await escalate('The fix requires a code change.')).toContain('changed files and why');
  });
});
