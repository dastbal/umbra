import { describeErrorOrigin } from './error-origin';

/** Builds an error with a controlled stack, the way a thrown one arrives. */
function withStack(error: Error, frames: string[]): Error {
  error.stack = [`${error.name}: ${error.message}`, ...frames.map((f) => `    at ${f}`)].join('\n');
  return error;
}

describe('describeErrorOrigin', () => {
  it('reports the frame inside the project, not LangChain wrapper', () => {
    // The live failure of 2026-08-28. `MiddlewareError` copies its cause's
    // message and keeps its own stack, so the CLI showed a frame in a
    // dependency for a defect in this repository.
    const cause = withStack(
      new TypeError("Cannot read properties of undefined (reading 'message')"),
      [
        'closeDelegation (src/core/agent/orchestration-guard.middleware.ts:151:20)',
        'process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
      ],
    );
    const wrapper = withStack(
      new Error("Cannot read properties of undefined (reading 'message')"),
      ['MiddlewareError.wrap (node_modules/langchain/dist/agents/errors.cjs:69:10)'],
    );
    (wrapper as { cause?: unknown }).cause = cause;

    const origin = describeErrorOrigin(wrapper);

    expect(origin.message).toBe("Cannot read properties of undefined (reading 'message')");
    expect(origin.detail).toContain('orchestration-guard.middleware.ts:151');
    expect(origin.detail).not.toContain('MiddlewareError.wrap');
  });

  it('surfaces a deeper message the wrapper replaced', () => {
    // A wrapper that copied the message adds nothing by repeating it. One that
    // changed the message hid the original, and that is the useful half.
    const cause = withStack(new Error('ENOENT: no such file .umbra/agent.config.json'), [
      'readAgentConfig (src/core/config/agent-config.ts:44:11)',
    ]);
    const wrapper = new Error('Middleware failed');
    (wrapper as { cause?: unknown }).cause = cause;

    const origin = describeErrorOrigin(wrapper);

    expect(origin.message).toBe('Middleware failed');
    expect(origin.detail).toContain('ENOENT');
    expect(origin.detail).toContain('agent-config.ts:44');
  });

  it('uses the error own frame when nothing wrapped it', () => {
    const error = withStack(new Error('Recursion limit of 50 reached'), [
      'CompiledStateGraph._runLoop (node_modules/@langchain/langgraph/dist/pregel/index.cjs:1:1)',
    ]);

    expect(describeErrorOrigin(error).detail).toContain('CompiledStateGraph._runLoop');
  });

  it('follows more than one level, because the real cause was two down', () => {
    const root = withStack(new Error('socket hang up'), ['TLSSocket.onHangUp (node:_tls_wrap:1:1)']);
    const middle = new Error('fetch failed');
    (middle as { cause?: unknown }).cause = root;
    const outer = new Error('Model request failed');
    (outer as { cause?: unknown }).cause = middle;

    expect(describeErrorOrigin(outer).detail).toContain('socket hang up');
  });

  it('says nothing rather than pointing at the reporting machinery', () => {
    // A wrapper with no cause and only its own wrapper frame has nothing to
    // offer. An unhelpful line is worse than an absent one: it reads as an
    // answer.
    const wrapper = withStack(new Error('Middleware failed'), [
      'MiddlewareError.wrap (node_modules/langchain/dist/agents/errors.cjs:69:10)',
    ]);

    expect(describeErrorOrigin(wrapper)).toEqual({ message: 'Middleware failed' });
  });

  it('stops instead of looping on an error that causes itself', () => {
    const looped = new Error('circular');
    (looped as { cause?: unknown }).cause = looped;

    expect(describeErrorOrigin(looped).message).toBe('circular');
  });

  it('survives whatever a turn actually throws', () => {
    expect(describeErrorOrigin(undefined)).toEqual({ message: 'Unknown error' });
    expect(describeErrorOrigin(null)).toEqual({ message: 'Unknown error' });
    expect(describeErrorOrigin({})).toEqual({ message: 'Unknown error' });
    expect(describeErrorOrigin('plain string')).toEqual({ message: 'plain string' });
    expect(describeErrorOrigin({ message: 42 })).toEqual({ message: 'Unknown error' });
  });
});
