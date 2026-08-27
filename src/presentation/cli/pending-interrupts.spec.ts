import { readPendingInterrupts } from './pending-interrupts';

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
