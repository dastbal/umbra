import { createMiddleware } from 'langchain';

/**
 * @module CompactTodoTool
 *
 * The planning tool, at a price proportionate to what it does.
 *
 * ## What it cost
 *
 * deepagents installs `todoListMiddleware()` on every deep agent, and the
 * `write_todos` description it ships is 11,389 characters. Measured at the
 * provider boundary on the default configuration (`gemini-2.5-flash-lite`,
 * `npm run bench:floor`), that one description was **2,650 tokens** — more
 * than the other eleven tools of the catalog together, four times over, and
 * 37% of the 7,239 tokens every turn paid before the user said anything. 66%
 * of it was `<example>` blocks, and most of the rest restated rules the deep
 * prompt already gives in its own words (small tasks skip the list, medium
 * ones plan three to five steps, large ones plan in full).
 *
 * ## Why the description is replaced, not the tool removed
 *
 * The tool is load-bearing. The deep and orchestrator prompts plan with it and
 * the CLI renders it; removing it would change how the agent works, not what it
 * costs. What the model needs is the rules. This keeps every one of them —
 * the three states, in-progress before starting, completed only when fully
 * done, a blocker kept open with its own item — and drops the examples.
 *
 * ## Why at the model call, and not through `todoListMiddleware({ toolDescription })`
 *
 * That option is the obvious route, and it does not survive deepagents. The
 * library constructs its own `todoListMiddleware()` with no options, so a
 * configured one has to replace it: exclude the default through a harness
 * profile, add the configured instance. But the exclusion filters the *whole*
 * middleware array by name, custom entries included — a replacement named
 * `todoListMiddleware` is removed along with the default. Renamed to dodge the
 * filter, it survives; and then any model that resolves to the empty harness
 * profile, where nothing is excluded, receives two tools called `write_todos`.
 * Correctness would depend on every profile registration staying in step.
 *
 * ## Why the tool's own description is set, and not a copy of the tool
 *
 * A copy is what deepagents does for `toolDescriptionOverrides`, and it only
 * works there because deepagents clones *before* the tool is registered. In a
 * hook the registered tool is fixed: `AgentNode` rejects any tool in
 * `wrapModelCall` that shares a registered name but is a different object —
 * "to preserve ToolNode execution identity". The model would be shown one
 * object while `ToolNode` executed another. Filtering is allowed; replacing is
 * not.
 *
 * That rule protects *which object runs*. It says nothing about what a tool
 * says about itself. So this sets the `description` of the registered instance
 * — the same object, still the one that executes — and passes the request on
 * unchanged. It is safe to do in place for three reasons, each verified against
 * the installed package: `description` is an own writable property, every
 * `todoListMiddleware()` builds a fresh tool, and so the change stays inside the
 * one agent that owns it. It is idempotent, so a second call writes nothing.
 *
 * The first version of this module did clone, passed `tsc`, and was refused at
 * the first model call. Every unit test mocks deepagents, so none of them could
 * have seen it; the refusal surfaced only when `npm run bench:floor` built the
 * real agent.
 */

/**
 * The rules of `write_todos`, without the worked examples.
 *
 * Every behavioural claim here is true of the installed tool: its `todos`
 * channel has no reducer, so each call replaces the list rather than merging
 * into it — which is why the model is told to send the whole list.
 */
export const COMPACT_WRITE_TODOS_DESCRIPTION = [
  'Create and update a structured task list for the current work. Each item has a status: pending, in_progress, or completed.',
  '',
  'Use it for work of three or more distinct steps, or when the user gives several tasks at once. Skip it for a single straightforward change, a trivial task, or a purely conversational message.',
  '',
  'Rules:',
  '- Each call replaces the whole list, so always send every item, not only the ones that changed.',
  '- Mark an item in_progress before you start it. While work remains, keep at least one item in_progress.',
  '- Mark an item completed as soon as it is fully done, never in a batch.',
  '- Never mark an item completed when there are unresolved errors, the work is partial, or you are blocked. Keep it in_progress and add an item that describes the blocker.',
  '- Add follow-up items as you discover them and remove the ones that no longer apply. Never change an item that is already completed.',
].join('\n');

/** The name deepagents' todo middleware publishes its tool under. */
const WRITE_TODOS = 'write_todos';

/** The one property this module changes on a registered tool. */
interface DescribedTool {
  name?: unknown;
  description?: unknown;
}

/**
 * Shows the model the compact `write_todos` description on every call.
 *
 * The request is passed on as it arrived: same array, same tool objects. Only
 * the registered `write_todos` instance's description changes, which is what
 * keeps `AgentNode`'s execution-identity check satisfied. A request that
 * carries no `write_todos` is untouched, so a mode that never received the tool
 * pays nothing and loses nothing.
 *
 * @returns Middleware for the deep agents' `middleware` arrays, placed first so
 * every later hook — the turn governor included — already sees the compact tool.
 */
export function createCompactTodoToolMiddleware() {
  return createMiddleware({
    name: 'UmbraCompactTodoTool',
    wrapModelCall: async (request, handler) => {
      for (const tool of request.tools as DescribedTool[]) {
        if (tool.name === WRITE_TODOS && tool.description !== COMPACT_WRITE_TODOS_DESCRIPTION) {
          tool.description = COMPACT_WRITE_TODOS_DESCRIPTION;
        }
      }
      return handler(request);
    },
  });
}
