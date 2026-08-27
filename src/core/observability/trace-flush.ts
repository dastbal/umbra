import { Client } from 'langsmith';

/** How long to wait for pending LangSmith uploads before giving up. */
const DEFAULT_FLUSH_TIMEOUT_MS = 2000;

/**
 * Reports whether LangSmith tracing is active for this process.
 *
 * Both the legacy `LANGCHAIN_*` and the current `LANGSMITH_*` names are checked,
 * because `langsmith/langchain` honours either.
 *
 * @returns `true` when traces are being sent and therefore worth flushing.
 */
export function isTracingEnabled(): boolean {
  const flag = process.env.LANGSMITH_TRACING ?? process.env.LANGCHAIN_TRACING_V2;
  const apiKey = process.env.LANGSMITH_API_KEY ?? process.env.LANGCHAIN_API_KEY;
  return (flag === 'true' || flag === '1') && typeof apiKey === 'string' && apiKey.length > 0;
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
