import { createAgent } from 'langchain';
import type { SubAgent } from 'deepagents';
import { createSubagentBudgetMiddleware } from './subagent-budget.middleware';

/** A compiled delegate, invocable with a state and a config. */
export interface CompiledSubagent {
  /** Runs the delegate to completion or to a suspension. */
  invoke(state: Record<string, unknown>, config?: unknown): Promise<unknown>;
}

/** The three delegates of the orchestration lifecycle, compiled and ready. */
export type SubagentGraphs = Record<string, CompiledSubagent>;

/**
 * Compiles the delegates this project dispatches to.
 *
 * ## Why this project builds them instead of `deepagents`
 *
 * The delegation tool's schema is the mandate itself (ADR-015), and a tool with
 * our schema has to know who to invoke. `deepagents` builds its subagent graphs
 * inside the closure of `createTaskTool` and exposes them nowhere, so owning the
 * schema means owning the dispatch. That is the reason.
 *
 * The consequence is the reward, and it closes a defect that had already killed
 * a run. `docs/deferred-work.md` records it: deepagents' filesystem middleware
 * hands every subagent tools the harness profile excluded from the main agent —
 * a Coder reaching for `read_file` instead of `safe_read_file` ended a
 * delegation with *"Received tool input did not match expected schema"*. The
 * exclusion never followed, because a subagent is a separate graph with its own
 * middleware stack. Compiled here, **a delegate holds exactly the tools its
 * specification declares**, and there is no second place for the list to be
 * assembled.
 *
 * The specifications themselves are untouched — the same
 * `createResearcherSubAgent`, `createCoderSubAgent` and `createVerifierSubAgent`
 * that described these delegates before still describe them. Only who reads them
 * changed.
 *
 * ## The checkpointer
 *
 * Deliberately not passed. Measured on 2026-08-27: `interrupt()` resolves its
 * config through async-local-storage, so inside a nested invoke a delegate
 * already inherits the orchestrator's checkpointer and suspends correctly
 * without one of its own. Giving a delegate a second checkpointer would create a
 * second place where the same run is persisted, for no capability gained.
 *
 * @param specs - The delegate specifications, keyed by role.
 * @returns The compiled delegates.
 */
export function buildSubagentGraphs(
  specs: Record<string, SubAgent>,
): SubagentGraphs {
  return Object.fromEntries(
    Object.entries(specs).map(([roleId, spec]) => [roleId, compile(spec)]),
  );
}

/**
 * Compiles one delegate from its specification.
 *
 * The budget middleware is appended rather than assumed: a specification that
 * already carries it keeps exactly one, because two would charge every tool
 * attempt twice and exhaust a delegate at half its grant.
 *
 * @param spec - The delegate specification.
 * @returns The compiled delegate.
 */
function compile(spec: SubAgent): CompiledSubagent {
  const declared = spec.middleware ?? [];
  const hasBudget = declared.some((one) => (one as { name?: string }).name === 'SubagentBudget');
  const middleware = hasBudget ? [...declared] : [...declared, createSubagentBudgetMiddleware()];

  return createAgent({
    model: spec.model as never,
    systemPrompt: spec.systemPrompt,
    tools: (spec.tools ?? []) as never,
    middleware: composeSubagentMiddleware(spec) as never,
    name: spec.name,
    ...(spec.responseFormat != null ? { responseFormat: spec.responseFormat } : {}),
  } as never) as unknown as CompiledSubagent;
}

/**
 * Reports the tool names a compiled delegate is allowed to call.
 *
 * Exported for the contract test. Reading the specification is not enough to
 * know what a delegate ends up holding — that is precisely the blind spot
 * `docs/deferred-work.md` names — but with the graph built here the
 * specification *is* the answer, and this function is what lets a test assert
 * that rather than trust it.
 *
 * @param spec - The delegate specification.
 * @returns The declared tool names.
 */
export function declaredToolNames(spec: SubAgent): string[] {
  return (spec.tools ?? []).map((tool) => (tool as { name: string }).name);
}

/**
 * Builds the middleware stack a delegate runs with.
 *
 * The budget middleware is appended rather than assumed: a specification that
 * already carries it keeps exactly one, because two would charge every tool
 * attempt twice and exhaust a delegate at half the grant it was told it had.
 *
 * Exported because this is the decision worth testing. Asserting it through the
 * compiled graph would mean reading `ReactAgent` internals, which is a test that
 * breaks when the library reorganizes and proves little when it passes.
 *
 * @param spec - The delegate specification.
 * @returns The middleware stack, with the budget present exactly once.
 */
export function composeSubagentMiddleware(spec: SubAgent): readonly { name: string }[] {
  const declared = (spec.middleware ?? []) as unknown as { name: string }[];
  const hasBudget = declared.some((one) => one.name === 'SubagentBudget');

  return hasBudget
    ? [...declared]
    : [...declared, createSubagentBudgetMiddleware() as unknown as { name: string }];
}
