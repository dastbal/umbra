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

/**
 * Repaints one terminal line when Umbra owns an interactive stdout.
 *
 * Redirected output and MCP diagnostics deliberately receive complete lines:
 * control characters would make logs unreadable and would be fatal on MCP's
 * protocol stdout. The active sink is the authority for that distinction.
 *
 * @param line - Current transient status without a trailing newline.
 * @returns Nothing.
 */
export function writeTransientLine(line: string): void {
  if (activeSink === defaultSink && process.stdout.isTTY) {
    const fitted = fitTerminalProgress(line);
    process.stdout.write(`\r\u001b[2K${colorizeTransientProgress(fitted)}`);
    return;
  }
  activeSink(line);
}

/** Finishes an interactive transient line before durable output is written. */
export function finishTransientLine(): void {
  if (activeSink === defaultSink && process.stdout.isTTY) process.stdout.write('\n');
}

/**
 * Keeps dynamic progress within one physical terminal row.
 *
 * Padding to a stable width prevents short status messages leaving remnants of
 * longer ones, while truncation prevents a long path from wrapping and making
 * the terminal appear to jump.
 */
function fitTerminalProgress(line: string): string {
  const terminalColumns = process.stdout.columns ?? 100;
  const width = Math.max(40, Math.min(96, terminalColumns - 2));
  const visible = line.length > width ? `${line.slice(0, Math.max(0, width - 1))}…` : line;
  return visible.padEnd(width, ' ');
}

/** Adds terminal-only colour after measuring the plain fixed-width line. */
function colorizeTransientProgress(line: string): string {
  const parts = line.split('|');
  if (parts.length < 4) return line;
  const [percentage, position, filePath, ...status] = parts;
  const state = status.join('|');
  const stateColor = /saved/.test(state)
    ? ANSI.green
    : /working/.test(state)
      ? ANSI.yellow
      : /embedding|embedded/.test(state)
        ? ANSI.magenta
        : ANSI.cyan;
  return `${ANSI.brightCyan}${percentage}${ANSI.reset}${ANSI.dim}|${ANSI.reset}` +
    `${ANSI.cyan}${position}${ANSI.reset}${ANSI.dim}|${ANSI.reset}` +
    `${ANSI.yellow}${filePath}${ANSI.reset}${ANSI.dim}|${ANSI.reset}` +
    `${stateColor}${state}${ANSI.reset}`;
}

/** ANSI palette deliberately local to interactive terminal output. */
const ANSI = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  brightCyan: '\u001b[96m',
  cyan: '\u001b[36m',
  yellow: '\u001b[33m',
  magenta: '\u001b[35m',
  green: '\u001b[32m',
} as const;
