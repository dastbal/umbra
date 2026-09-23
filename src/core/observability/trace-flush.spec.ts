import { awaitAllCallbacks } from '@langchain/core/callbacks/promises';
import {
  flushPendingTraces,
  isTracingEnabled,
  suppressLangSmithTransportLogs,
} from './trace-flush';

// The mock target is the callback barrier, not the LangSmith client. Waiting on
// a freshly constructed `Client` was the defect: its queue is per instance and
// the tracer posts through the module singleton, so the old flush awaited an
// empty queue and returned while the batch was still in flight.
jest.mock('@langchain/core/callbacks/promises', () => ({
  awaitAllCallbacks: jest.fn(),
}));

const mockAwaitAllCallbacks = awaitAllCallbacks as jest.MockedFunction<typeof awaitAllCallbacks>;

describe('trace flushing on exit', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.LANGSMITH_TRACING;
    delete process.env.LANGSMITH_API_KEY;
    process.env.LANGCHAIN_TRACING_V2 = 'true';
    process.env.LANGCHAIN_API_KEY = 'ls-test-key';
    mockAwaitAllCallbacks.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  describe('isTracingEnabled', () => {
    it('is true only when both the flag and a key are present', () => {
      expect(isTracingEnabled()).toBe(true);

      process.env.LANGCHAIN_TRACING_V2 = 'false';
      expect(isTracingEnabled()).toBe(false);

      process.env.LANGCHAIN_TRACING_V2 = 'true';
      delete process.env.LANGCHAIN_API_KEY;
      expect(isTracingEnabled()).toBe(false);
    });

    it('honours the current LANGSMITH_* names too', () => {
      delete process.env.LANGCHAIN_TRACING_V2;
      delete process.env.LANGCHAIN_API_KEY;
      process.env.LANGSMITH_TRACING = '1';
      process.env.LANGSMITH_API_KEY = 'ls-test-key';
      expect(isTracingEnabled()).toBe(true);
    });
  });

  it('waits on the queue the tracer actually posts through', async () => {
    await flushPendingTraces();
    expect(mockAwaitAllCallbacks).toHaveBeenCalledTimes(1);
  });

  it('does nothing at all when tracing is off', async () => {
    process.env.LANGCHAIN_TRACING_V2 = 'false';
    await flushPendingTraces();
    expect(mockAwaitAllCallbacks).not.toHaveBeenCalled();
  });

  it('gives up at the timeout instead of holding the terminal', async () => {
    // A hung observability backend must never stop the process from exiting.
    mockAwaitAllCallbacks.mockImplementation(() => new Promise(() => undefined));
    const started = Date.now();
    await flushPendingTraces(30);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('swallows a failing flush so the exit path is unchanged', async () => {
    mockAwaitAllCallbacks.mockRejectedValue(new Error('backend down'));
    await expect(flushPendingTraces(30)).resolves.toBeUndefined();
  });

  it('survives a barrier that throws synchronously', async () => {
    mockAwaitAllCallbacks.mockImplementationOnce(() => {
      throw new Error('no api key');
    });
    await expect(flushPendingTraces(30)).resolves.toBeUndefined();
  });
});

describe('LangSmith transport logs', () => {
  it('hides only known background-upload failures', () => {
    const error = jest.fn();
    const warn = jest.fn();
    const terminal = { error, warn };
    suppressLangSmithTransportLogs(terminal);

    terminal.error('Error exporting batch:', new Error('network unavailable'));
    terminal.warn('LangSmith trace upload failed; data saved to C:/traces');
    terminal.error('Provider request failed');

    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith('Provider request failed');
    expect(warn).not.toHaveBeenCalled();
  });
});
