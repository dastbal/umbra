/**
 * One suspension the graph is waiting on, as LangGraph records it in state.
 *
 * The shape matches what a `GraphInterrupt` carries and what
 * `ChatSession#handleHITL` already consumes, so a pending interrupt read from
 * state is interchangeable with one that arrived as an event.
 */
export interface PendingInterrupt {
  /** LangGraph's identifier for the suspension point. */
  id?: string;
  /** The payload the tool passed to `interrupt()`. */
  value?: unknown;
}

/**
 * Reads the suspensions a graph is waiting on out of its persisted state.
 *
 * ## Why state and not the event stream
 *
 * `ChatSession` drives the agent with `streamEvents(..., { version: 'v2' })`
 * and looked for `__interrupt__` on `on_chain_end`. Measured on 2026-08-27
 * against a real graph: **that key never appears on any event.** A tool that
 * suspends emits `on_tool_start` and then `on_tool_error`, never `on_tool_end`,
 * and the stream finishes normally with no suspension visible anywhere in it.
 *
 * The graph, meanwhile, is genuinely suspended and waiting — `getState` reports
 * `tasks: ['tools']` with one pending interrupt. So the operator saw a spinner
 * that never resolved: the run had stopped for an answer nobody was asked for.
 * That is the 145-second "hang" of that day, and it applied to every
 * `interrupt()` in the CLI, the `AgentSecurityPolicy` approval gate of ADR-011
 * included.
 *
 * State is the authority. The stream is a view of it, and this particular view
 * omits exactly the thing that must not be missed.
 *
 * @param state - The value returned by a compiled graph's `getState`.
 * @returns Every pending suspension, in task order; empty when none are open.
 */
export function readPendingInterrupts(state: unknown): PendingInterrupt[] {
  if (!isRecord(state)) return [];

  const fromTasks = Array.isArray(state['tasks'])
    ? state['tasks'].flatMap((task) => readInterruptList(isRecord(task) ? task['interrupts'] : undefined))
    : [];

  // Some LangGraph versions also surface them at the top level. Reading both is
  // cheaper than depending on which one this version populates.
  const fromState = readInterruptList(state['interrupts']);

  return dedupeById([...fromTasks, ...fromState]);
}

/**
 * One suspension and the value the operator gave for it.
 */
export interface AnsweredInterrupt {
  /** The suspension's LangGraph id, when it carried one. */
  id?: string;
  /** The value to hand back to the tool waiting on that suspension. */
  answer: unknown;
}

/**
 * LangGraph's own test for a resume key: a 128-bit XXH3 digest in hex.
 *
 * Copied deliberately rather than imported — `isXXH3` is internal to
 * `@langchain/langgraph` (`dist/hash.js`) and not part of its public surface.
 * The consequence of getting it wrong is silent, so it is spelled out here
 * instead of approximated as "a non-empty string".
 */
const RESUME_KEY = /^[0-9a-f]{32}$/;

/**
 * Decides whether a set of suspensions can be answered one by one.
 *
 * Asked *before* the operator is prompted, because a set that cannot be
 * correlated must not be put in front of them: collecting three answers and
 * then discarding two is worse than asking for one.
 *
 * @param ids - The ids of the suspensions awaiting an answer.
 * @returns `true` when every suspension can carry its own answer.
 */
export function canCorrelateResume(ids: Array<string | undefined>): boolean {
  return ids.length > 0 && ids.every((id) => typeof id === 'string' && RESUME_KEY.test(id));
}

/**
 * Builds the value that resumes a suspended run, correlated where it can be.
 *
 * ## Why this is not simply an object
 *
 * `Command({ resume })` has two modes and the runtime picks between them
 * silently. `mapCommand` uses the per-task mode **only** when the value is an
 * object whose keys are *all* XXH3 digests; a single key that is not sends the
 * whole value to `NULL_TASK_ID` instead — a broadcast, where one answer is
 * written to every task waiting in that super-step.
 *
 * That difference is the whole point. Two writes gated in one assistant message
 * suspend as two tasks, and under the broadcast one approval authorizes both —
 * including the one the operator was never shown. So a set where every id is a
 * real digest is correlated, and a set where any id is missing or malformed
 * answers the first suspension alone rather than silently authorizing the rest.
 *
 * @param answered - Each pending suspension with the value that answers it.
 * @returns The payload for `Command({ resume })`, or `undefined` when there is
 * nothing to answer.
 */
export function buildResumePayload(answered: AnsweredInterrupt[]): unknown {
  if (answered.length === 0) return undefined;
  if (!canCorrelateResume(answered.map((entry) => entry.id))) return answered[0]!.answer;

  const payload: Record<string, unknown> = {};
  for (const entry of answered) payload[entry.id as string] = entry.answer;

  return payload;
}

function readInterruptList(value: unknown): PendingInterrupt[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    return [{
      id: typeof entry['id'] === 'string' ? entry['id'] : undefined,
      value: entry['value'],
    }];
  });
}

/**
 * Drops repeats of the same suspension.
 *
 * A suspension read from both the task list and the top-level key is one
 * suspension, and asking the operator about it twice would be a defect visible
 * to them.
 */
function dedupeById(interrupts: PendingInterrupt[]): PendingInterrupt[] {
  const seen = new Set<string>();

  return interrupts.filter((interrupt) => {
    if (interrupt.id === undefined) return true;
    if (seen.has(interrupt.id)) return false;
    seen.add(interrupt.id);
    return true;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
