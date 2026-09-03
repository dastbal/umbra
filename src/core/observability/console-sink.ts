/**
 * The single seam through which Umbra's diagnostic output leaves the process.
 *
 * ## Why this exists
 *
 * Under `umbra mcp` (ADR-024) `stdout` carries JSON-RPC and nothing else. A
 * single stray byte written there corrupts the connection before the first
 * response, and the failure is silent from the client's side: the handshake
 * simply never completes.
 *
 * The alternative to this module was rewriting every call site to take a
 * logger. There are twenty-one of them across the read-only tool paths, all
 * correct as written, and none of them is the thing that needs to change — the
 * *destination* is. So the destination became injectable and the call sites
 * were left alone.
 *
 * ## Why it lives in `observability/` and not in `tools/utils/`
 *
 * `src/core/rag/` needs it too, and `rag/` importing from `tools/` inverts the
 * layer direction that `AGENTS.md` fixes. `observability/` is already a core
 * subsystem both may depend on.
 *
 * @example
 * ```ts
 * // At the top of the MCP subcommand, before anything can print:
 * setLogSink((line) => process.stderr.write(line + '\n'));
 * ```
 */

/** Receives one fully formatted line, without a trailing newline. */
export type LogSink = (line: string) => void;

/**
 * Writes to `stdout` via `console.log`, which is correct for every mode except
 * the MCP server.
 */
const defaultSink: LogSink = (line: string) => {
  console.log(line);
};

let activeSink: LogSink = defaultSink;

/**
 * Redirects every subsequent diagnostic line to `next`.
 *
 * Idempotent in effect but not cumulative: the last call wins. Intended to be
 * called once, during process startup, before any subsystem can print.
 *
 * @param next - Destination for formatted diagnostic lines.
 */
export function setLogSink(next: LogSink): void {
  activeSink = next;
}

/**
 * Restores the default `stdout` destination.
 *
 * Exists for tests, which must not leak a redirected sink into the next spec.
 */
export function resetLogSink(): void {
  activeSink = defaultSink;
}

/**
 * Emits one formatted line to the active destination.
 *
 * @param line - The line to write, without a trailing newline.
 */
export function writeLine(line: string): void {
  activeSink(line);
}

/**
 * Emits text with no newline handling of its own, for callers that were using
 * `process.stdout.write` directly to draw progress.
 *
 * Kept separate from {@link writeLine} because the two have different
 * contracts, and collapsing them would silently add newlines to progress
 * output. When a sink is active the fragment is delivered as its own line,
 * because a sink writes lines — a progress dot is not worth inventing a
 * buffering protocol for.
 *
 * @param fragment - Text to emit.
 */
export function writeFragment(fragment: string): void {
  if (activeSink === defaultSink) {
    process.stdout.write(fragment);
    return;
  }
  activeSink(fragment);
}
