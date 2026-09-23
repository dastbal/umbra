/**
 * @module CompactTodoTool
 *
 * The rules of `write_todos`, at a price proportionate to what the tool does.
 *
 * ## What it cost
 *
 * The description `todoListMiddleware` ships is 11,389 characters. Measured at
 * the provider boundary on the default configuration (`gemini-2.5-flash-lite`,
 * `npm run bench:floor`), that one description was **2,650 tokens** — more than
 * the other eleven tools of the catalog together, four times over. 66% of it was
 * `<example>` blocks, and most of the rest restated rules the deep prompt already
 * gives in its own words. This keeps every rule and none of the examples: 291
 * tokens.
 *
 * ## How it reaches the model
 *
 * `DeepAgentFactory` installs `todoListMiddleware({ toolDescription })` itself, in
 * the two agents whose prompts plan with the tool — deep and the orchestrator —
 * and nowhere else. That is the library's own option, used directly.
 *
 * It was not always possible. Up to deepagents 1.13 the library installed
 * `todoListMiddleware()` on every deep agent with no options, so this module
 * shipped a `wrapModelCall` middleware that set the description on the
 * registered tool in place. Two simpler routes were refused by the installed
 * packages then, and are recorded so they are not re-proposed:
 *
 * - Replacing deepagents' default with a configured instance needed a harness
 *   exclusion, and that exclusion filtered the whole middleware array by name —
 *   a replacement called `todoListMiddleware` was removed with the default.
 * - Cloning the tool in `wrapModelCall` passed `tsc` and was refused by
 *   `AgentNode` at the first model call, "to preserve ToolNode execution
 *   identity". `compact-todo-tool.middleware.spec.ts` still pins that rule.
 *
 * deepagents 1.14 stopped installing the todo list by default, so there is no
 * default left to replace and the native option is the whole mechanism. See
 * ADR-031, amendments of 2026-09-23.
 */

/**
 * The rules of `write_todos`, without the worked examples.
 *
 * Every behavioural claim here is true of the installed tool: its `todos`
 * channel has no reducer, so each call replaces the list rather than merging
 * into it — which is why the model is told to send the whole list. The spec
 * proves that by writing twice through a real agent.
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
