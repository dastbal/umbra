import { Client } from 'langsmith';

/** How long to wait for pending LangSmith uploads before giving up. */
const DEFAULT_FLUSH_TIMEOUT_MS = 2000;

/** Console surface used by the LangSmith transport-log filter. */
interface TransportLogConsole {
  error: (...data: unknown[]) => void;
  warn: (...data: unknown[]) => void;
}

/** Prevents installing the same wrappers twice in a long-lived CLI process. */
const silencedConsoles = new WeakSet<object>();

/** Identifies only the known background-upload messages emitted by LangSmith. */
function isLangSmithTransportLog(data: readonly unknown[]): boolean {
  const message = data[0];
  return typeof message === 'string' && /^(?:Error exporting batch:|Error in (?:postRun|patchRun) for run |LangSmith trace upload failed;|LangSmith tracing error:)/.test(message);
}

/**
 * Suppresses LangSmith's own background transport noise without disabling tracing.
 *
 * The LangSmith client catches failed asynchronous uploads internally and writes
 * them to the global console, outside the CLI's normal error boundary. This
 * filters only those documented transport prefixes; provider and agent errors
 * continue to be displayed unchanged.
 *
 * @param terminal - Console implementation to wrap. Injectable for tests.
 */
export function suppressLangSmithTransportLogs(terminal: TransportLogConsole = console): void {
  if (silencedConsoles.has(terminal)) return;
  silencedConsoles.add(terminal);

  for (const level of ['error', 'warn'] as const) {
    const write = terminal[level].bind(terminal);
    terminal[level] = (...data: unknown[]): void => {
      if (!isLangSmithTransportLog(data)) write(...data);
    };
  }
}

function isTracingEnabledIn(environment: NodeJS.ProcessEnv): boolean {
  const flag = environment.LANGSMITH_TRACING ?? environment.LANGCHAIN_TRACING_V2;
  const apiKey = environment.LANGSMITH_API_KEY ?? environment.LANGCHAIN_API_KEY;
  return (flag === 'true' || flag === '1') && typeof apiKey === 'string' && apiKey.length > 0;
}

/**
 * Reports whether LangSmith tracing is active for this process.
 *
 * Both the legacy `LANGCHAIN_*` and the current `LANGSMITH_*` names are checked,
 * because `langsmith/langchain` honours either.
 *
 * @returns `true` when traces are being sent and therefore worth flushing.
 */
export function isTracingEnabled(): boolean {
  return isTracingEnabledIn(process.env);
}

/**
 * Waits for LangSmith to upload its pending trace batches.
 *
 * The tracer uploads in background batches, so `process.exit()` discards
 * whatever is still queued. That is why the runs that failed were exactly the
 * ones missing from the project: the CLI died before their batch went out, and
 * the sessions worth debugging were the ones with no trace to read.
 *
 * Never throws and never blocks past `timeoutMs`: losing a trace is a worse
 * outcome than exiting, but a hung observability backend must not hold the
 * terminal.
 *
 * @param timeoutMs - Upper bound on the wait, in milliseconds.
 * @returns A promise that settles once the flush finishes or the bound elapses.
 */
export async function flushPendingTraces(
  timeoutMs: number = DEFAULT_FLUSH_TIMEOUT_MS,
): Promise<void> {
  if (!isTracingEnabled()) return;

  let timer: NodeJS.Timeout | undefined;
  try {
    const client = new Client();
    await Promise.race([
      client.awaitPendingTraceBatches(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } catch {
    // A failed flush must not change the exit path.
  } finally {
    if (timer) clearTimeout(timer);
  }
}
