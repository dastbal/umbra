/**
 * @module SessionOverhead
 *
 * The fixed cost of every request in a session: the system prompt and the tool
 * catalog.
 *
 * ## Why a registry rather than a parameter
 *
 * These two are charged on **every** turn and change on none of them. A deep
 * agent publishes its whole tool catalog with each request, which is thousands
 * of tokens before the conversation contributes anything, and the system prompt
 * is charged again each time.
 *
 * They are also assembled deep inside `DeepAgentFactory` and then handed to
 * `createDeepAgent`, which keeps them. Nothing downstream holds a reference —
 * `ChatSession#checkAndCompressContext` had the message list and nothing else.
 * That is precisely why the budget guard has always measured a number smaller
 * than the request it guards (ADR-031 phase 2).
 *
 * Threading them through every call site would mean editing `chat-session.ts`,
 * which ADR-031 froze at its current size. Recording them once where they are
 * built, and reading them where they are needed, changes no call site at all
 * and makes the count correct for every caller rather than for the one that
 * remembered to pass them.
 *
 * ## Why a module-level value is acceptable here
 *
 * One process serves one interactive session. `createDeepAgent` is called once
 * per agent construction, and a `/model` switch rebuilds it — which overwrites
 * this, correctly, because the new agent's catalog is the one being charged.
 * A subagent run does not overwrite it: {@link recordSessionOverhead} is called
 * only from the interactive construction paths, so a delegate's narrower tool
 * list never makes the supervisor's budget look cheaper than it is.
 */

/*
 * ## No production reader since ADR-037
 *
 * Its only reader was `ContextCompressor.estimateTokens`, called from
 * `isOverBudget` to decide when `ChatSession` compressed. Context editing
 * replaced that decision and counts the request it edits, inside the model
 * call, so both methods were removed and this registry is read only by
 * `scripts/bench-turn-floor.mjs` as its "believed" figure. Retiring it is
 * recorded in `docs/deferred-work.md`.
 */

import type { CountableTool } from '../llm/tokens/token-counter.port';

/** What every request in this session pays before its first message. */
export interface SessionOverhead {
  readonly system?: string;
  readonly tools?: readonly CountableTool[];
}

/** Anything with the shape a published tool has. Avoids importing LangChain here. */
interface ToolLike {
  readonly name?: unknown;
  readonly description?: unknown;
  readonly schema?: unknown;
}

let recorded: SessionOverhead = {};

/**
 * Converts a runtime tool into the shape the counter reads.
 *
 * The schema is converted to real JSON Schema when it is a zod object, because
 * that is what the provider is actually sent. Serializing the zod instance
 * itself would count its internal representation — a different number, larger
 * and unrelated to the wire format.
 *
 * @param tool - A tool as registered with the agent.
 * @returns The countable projection.
 */
export function toCountableTool(tool: ToolLike): CountableTool {
  let schema: unknown = tool.schema;

  if (schema !== undefined && schema !== null) {
    try {
      // Lazily required so this module stays usable where zod is not the
      // schema language, and so a zod version without `toJSONSchema` degrades
      // to counting the raw object rather than throwing during agent setup.
      const { z } = require('zod') as { z: { toJSONSchema?: (value: unknown) => unknown } };
      if (typeof z.toJSONSchema === 'function') schema = z.toJSONSchema(schema);
    } catch {
      // Keep the original; an approximate schema cost beats no schema cost.
    }
  }

  return {
    name: typeof tool.name === 'string' ? tool.name : '',
    description: typeof tool.description === 'string' ? tool.description : undefined,
    schema,
  };
}

/**
 * Records what this session will pay on every request.
 *
 * @param system - The system prompt handed to the agent.
 * @param tools - The tools registered with it.
 * @returns Nothing.
 */
export function recordSessionOverhead(system: string, tools: readonly ToolLike[]): void {
  recorded = { system, tools: tools.map(toCountableTool) };
}

/**
 * The overhead recorded for this session.
 *
 * Returns an empty object before an agent has been constructed, so a caller
 * that runs early counts the conversation alone rather than failing — the same
 * number it would have produced before this module existed.
 *
 * @returns The recorded overhead.
 */
export function sessionOverhead(): SessionOverhead {
  return recorded;
}

/**
 * Forgets the recorded overhead. Tests, and any caller that tears a session down.
 *
 * @returns Nothing.
 */
export function clearSessionOverhead(): void {
  recorded = {};
}
