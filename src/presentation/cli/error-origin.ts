/**
 * @module ErrorOrigin
 *
 * Finds the place a failed turn actually broke, rather than the place that
 * reported it.
 *
 * ## Why this exists
 *
 * On 2026-08-28 a session died with two lines:
 *
 * ```
 * ✗ Error
 * └─ Cannot read properties of undefined (reading 'message')
 *    at MiddlewareError.wrap (…/langchain/dist/agents/errors.cjs:69:10)
 * ```
 *
 * Both lines are true and neither is useful. `MiddlewareError` is LangChain's
 * wrapper for anything a middleware throws: it **copies the wrapped error's
 * message** onto itself (`errors.cjs:54`) and keeps the original in `cause`
 * (`errors.cjs:57`). Its own stack therefore begins where the wrapping
 * happened — inside LangChain — while the code that actually failed is one
 * level down and was never printed.
 *
 * So the operator was shown a frame in a dependency for a defect in this
 * repository, and the turn left nothing else behind. That is not a rendering
 * nicety: it is the difference between a bug that can be found and one that
 * cannot.
 *
 * ## What it does
 *
 * Walks the `cause` chain to its end and reports the deepest frame, because a
 * wrapper's stack describes the wrapping and the innermost stack describes the
 * failure. When the chain adds a message the outer error did not carry, that is
 * surfaced too.
 */

/** Frames belonging to the machinery that reports errors, not to the failure. */
const WRAPPER_FRAME = /\bat (MiddlewareError\.wrap|new MiddlewareError)\b/;

/** How deep a `cause` chain is followed before the walk gives up. */
const MAX_CAUSE_DEPTH = 8;

/** What the operator should be told about a failed turn. */
export interface ErrorOrigin {
  /** The message to headline, from the outermost error the turn threw. */
  message: string;
  /**
   * One line naming where it broke, or a deeper message the outer error hid.
   * Undefined when nothing beyond the headline could be established — said
   * plainly rather than filled with a frame from the reporting machinery.
   */
  detail?: string;
}

/**
 * Describes a thrown value in the two lines the CLI has room for.
 *
 * @param error - Whatever the turn threw. Any shape, including non-Errors.
 * @returns The headline message and, when one can be found, where it came from.
 */
export function describeErrorOrigin(error: unknown): ErrorOrigin {
  const chain = readCauseChain(error);
  const outermost = chain[0];
  const deepest = chain[chain.length - 1];

  const message = readMessage(outermost) ?? 'Unknown error';
  if (deepest === undefined || deepest === outermost) {
    return withDetail(message, firstMeaningfulFrame(outermost));
  }

  // A wrapper that copied its cause's message adds no information by repeating
  // it; what it hides is the frame. A wrapper that changed the message hid the
  // original, so that is worth the line instead.
  const deeperMessage = readMessage(deepest);
  const frame = firstMeaningfulFrame(deepest) ?? firstMeaningfulFrame(outermost);

  if (deeperMessage !== undefined && deeperMessage !== message) {
    return withDetail(message, frame ? `${deeperMessage} — ${frame}` : deeperMessage);
  }

  return withDetail(message, frame);
}

/**
 * Follows `cause` from the thrown value to the original failure.
 *
 * Bounded and cycle-guarded: an error that causes itself is rare and a hung
 * error renderer would be worse than an unhelpful one.
 *
 * @param error - The thrown value.
 * @returns The chain, outermost first. Empty when nothing object-like was thrown.
 */
function readCauseChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current = error;

  while (current !== undefined && current !== null && chain.length < MAX_CAUSE_DEPTH) {
    if (seen.has(current)) break;
    seen.add(current);
    chain.push(current);

    if (typeof current !== 'object') break;
    current = (current as { cause?: unknown }).cause;
  }

  return chain;
}

/**
 * Reads an error's message without assuming it is an `Error`.
 *
 * @param error - A link in the cause chain.
 * @returns The message, or undefined when there is none to read.
 */
function readMessage(error: unknown): string | undefined {
  if (typeof error === 'string') return error;
  if (typeof error !== 'object' || error === null) return undefined;

  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && message.length > 0 ? message : undefined;
}

/**
 * Returns the first stack frame that describes the failure.
 *
 * Frames belonging to LangChain's error wrapper are skipped: they are where the
 * report was assembled, which is precisely the answer that was useless.
 *
 * @param error - A link in the cause chain.
 * @returns A trimmed frame, or undefined when the stack offers none.
 */
function firstMeaningfulFrame(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;

  const stack = (error as { stack?: unknown }).stack;
  if (typeof stack !== 'string') return undefined;

  return stack
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .find((line) => line.startsWith('at ') && !WRAPPER_FRAME.test(line));
}

/**
 * Assembles the result, omitting an absent detail rather than emptying it.
 *
 * @param message - The headline.
 * @param detail - The supporting line, when one was found.
 * @returns The origin description.
 */
function withDetail(message: string, detail?: string): ErrorOrigin {
  return detail === undefined ? { message } : { message, detail };
}
