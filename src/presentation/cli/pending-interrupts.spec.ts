import { buildResumePayload, canCorrelateResume, readPendingInterrupts } from './pending-interrupts';

describe('readPendingInterrupts', () => {
  it('finds the suspension the event stream never reports', () => {
    // The exact shape observed on 2026-08-27 from a real suspended graph:
    // streamEvents showed on_tool_start then on_tool_error and finished, with
    // __interrupt__ absent from every event, while getState held this.
    const state = {
      tasks: [{
        name: 'tools',
        interrupts: [{
          id: '34b6aadeb74d54d169aa8ff25012c022',
          value: { kind: 'delegate_question', question: 'what did you mean?' },
        }],
      }],
    };

    expect(readPendingInterrupts(state)).toEqual([{
      id: '34b6aadeb74d54d169aa8ff25012c022',
      value: { kind: 'delegate_question', question: 'what did you mean?' },
    }]);
  });

  it('reports nothing for a graph that ran to completion', () => {
    expect(readPendingInterrupts({ tasks: [], values: { messages: [] } })).toEqual([]);
  });

  it('reports nothing for a task that is merely pending, without a suspension', () => {
    expect(readPendingInterrupts({ tasks: [{ name: 'tools' }] })).toEqual([]);
  });

  it('collects suspensions across every waiting task', () => {
    const state = {
      tasks: [
        { name: 'tools', interrupts: [{ id: 'a', value: 1 }] },
        { name: 'model', interrupts: [{ id: 'b', value: 2 }] },
      ],
    };

    expect(readPendingInterrupts(state).map((one) => one.id)).toEqual(['a', 'b']);
  });

  it('reads a suspension surfaced at the top level instead of on a task', () => {
    expect(readPendingInterrupts({ interrupts: [{ id: 'a', value: 'x' }] }))
      .toEqual([{ id: 'a', value: 'x' }]);
  });

  it('asks about one suspension once, however many places report it', () => {
    const state = {
      tasks: [{ name: 'tools', interrupts: [{ id: 'a', value: 'x' }] }],
      interrupts: [{ id: 'a', value: 'x' }],
    };

    expect(readPendingInterrupts(state)).toHaveLength(1);
  });

  it('keeps an unidentified suspension rather than discarding it', () => {
    // Dropping one because it carries no id would silently strand the run.
    const state = { tasks: [{ interrupts: [{ value: 'x' }, { value: 'y' }] }] };

    expect(readPendingInterrupts(state)).toHaveLength(2);
  });

  it('survives a graph with no checkpointer, which reports no state at all', () => {
    expect(readPendingInterrupts(undefined)).toEqual([]);
    expect(readPendingInterrupts(null)).toEqual([]);
    expect(readPendingInterrupts('not a state')).toEqual([]);
  });

  it('ignores a malformed interrupt list instead of throwing mid-turn', () => {
    expect(readPendingInterrupts({ tasks: [{ interrupts: 'nope' }] })).toEqual([]);
    expect(readPendingInterrupts({ tasks: [{ interrupts: [null, 3] }] })).toEqual([]);
  });
});

describe('canCorrelateResume', () => {
  it('accepts a set where every id is a real task digest', () => {
    expect(canCorrelateResume([
      '34b6aadeb74d54d169aa8ff25012c022',
      'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    ])).toBe(true);
  });

  it('refuses a set with a missing id', () => {
    expect(canCorrelateResume(['34b6aadeb74d54d169aa8ff25012c022', undefined])).toBe(false);
  });

  // A key that is not a digest does not fail loudly — LangGraph silently sends
  // the whole payload to every waiting task instead. So the predicate is the
  // digest itself, not "a non-empty string".
  it('refuses an id that is a string but not a digest', () => {
    expect(canCorrelateResume(['tools'])).toBe(false);
    expect(canCorrelateResume(['34B6AADEB74D54D169AA8FF25012C022'])).toBe(false);
    expect(canCorrelateResume(['34b6aadeb74d54d169aa8ff25012c0'])).toBe(false);
  });

  it('refuses an empty set, because there is nothing to correlate', () => {
    expect(canCorrelateResume([])).toBe(false);
  });
});

describe('buildResumePayload', () => {
  it('keys each answer by the suspension it answers', () => {
    const payload = buildResumePayload([
      { id: '34b6aadeb74d54d169aa8ff25012c022', answer: { decisions: [{ type: 'approve' }] } },
      { id: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', answer: { decisions: [{ type: 'reject' }] } },
    ]);

    expect(payload).toEqual({
      '34b6aadeb74d54d169aa8ff25012c022': { decisions: [{ type: 'approve' }] },
      'a1b2c3d4e5f60718293a4b5c6d7e8f90': { decisions: [{ type: 'reject' }] },
    });
  });

  // The failure this guards is silent and severe: a map with one non-digest key
  // is broadcast to every waiting task, so one approval would authorize a second
  // write the operator never saw.
  it('never mixes a keyed answer with an unkeyed one', () => {
    const payload = buildResumePayload([
      { id: '34b6aadeb74d54d169aa8ff25012c022', answer: { decisions: [{ type: 'approve' }] } },
      { id: undefined, answer: { decisions: [{ type: 'approve' }] } },
    ]);

    expect(payload).toEqual({ decisions: [{ type: 'approve' }] });
  });

  it('answers a lone uncorrelated suspension the way it always did', () => {
    expect(buildResumePayload([{ id: undefined, answer: { answer: 'the middleware' } }]))
      .toEqual({ answer: 'the middleware' });
  });

  it('has nothing to say when nothing is pending', () => {
    expect(buildResumePayload([])).toBeUndefined();
  });
});
