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
