import { z } from 'zod';
import { createAgent } from 'langchain';
import type { SubAgent } from 'deepagents';
import type { CompiledSubagent } from './subagent-registry';

/**
 * What a delegate says back before it is allowed to start.
 *
 * Three fields, and the third is the one that matters. A model can echo an
 * objective it did not read; naming the first concrete action it will take
 * requires having read the scope. Parroting is still possible — it is made
 * expensive, not impossible.
 */
export const readbackSchema = z.object({
  objective: z
    .string()
    .describe('What you understand you must achieve, in your own words. Do not copy the order.'),
  outOfScope: z
    .string()
    .describe('What you understand you must NOT do. Say "nothing stated" if the order gave none.'),
  firstAction: z
    .string()
    .describe('The first concrete thing you will do — a tool and its target, in one line.'),
});

/** A delegate's understanding of its order, before any work begins. */
export type Readback = z.infer<typeof readbackSchema>;

/**
 * Instruction that turns a delegate into a reader for one call.
 *
 * Appended to the order rather than replacing it, because a readback of a
 * different text proves nothing about the order that will actually be carried
 * out.
 */
const READBACK_INSTRUCTION = `

## Before you begin — read this order back

Do not carry out any of the work above yet. Reply only with your understanding of
it: the objective in your own words, what is out of scope, and the first concrete
action you will take. If the order contradicts itself or leaves out something you
need, say so in the objective rather than inventing a way around it.`;

/**
 * Compiles the readback counterpart of a delegate.
 *
 * ## Why the mechanism is worth the extra call
 *
 * Borrowed from aviation. A clearance is not given when the controller says it;
 * it is given when the pilot **reads it back** and the controller **hears** the
 * readback. The loop is closed, or the channel is treated as broken. Air traffic
 * control also grades it: routine clearances are read back and acted on, while
 * crossing a runway requires the controller to confirm before the aircraft
 * moves.
 *
 * This project validated the *form* of an order and never that the delegate
 * understood it. On 2026-08-27 a Researcher received a well-formed order, read
 * it as something else, and spent eighteen tool calls sweeping the codebase. A
 * readback would have shown that in the first second, before any budget was
 * spent.
 *
 * ## Why a separate graph
 *
 * Same model and same prompt, and **no tools at all**. A delegate asked to
 * describe its plan while holding the tools to execute it may simply begin; one
 * holding nothing can only answer. The guarantee is structural rather than a
 * request in a prompt.
 *
 * @param spec - The delegate specification being read back.
 * @returns A compiled agent that can only describe, never act.
 */
export function buildReadbackGraph(spec: SubAgent): CompiledSubagent {
  return createAgent({
    model: spec.model as never,
    systemPrompt: spec.systemPrompt,
    tools: [] as never,
    responseFormat: readbackSchema as never,
    name: `${spec.name}-readback`,
  } as never) as unknown as CompiledSubagent;
}

/** Readback counterparts of the three delegates. */
export type ReadbackGraphs = Record<string, CompiledSubagent>;

/**
 * Compiles a readback counterpart for each delegate.
 *
 * @param specs - The delegate specifications, keyed by role.
 * @returns The readback graphs.
 */
export function buildReadbackGraphs(
  specs: Record<string, SubAgent>,
): ReadbackGraphs {
  return Object.fromEntries(
    Object.entries(specs).map(([roleId, spec]) => [roleId, buildReadbackGraph(spec)]),
  );
}

/** Appends the readback instruction to a rendered order. */
export function asReadbackOrder(order: string): string {
  return `${order}${READBACK_INSTRUCTION}`;
}

/**
 * Reads a readback out of whatever the graph returned.
 *
 * A delegate that answers in prose instead of the schema has still told the
 * operator something, so its text is kept rather than discarded. What must never
 * happen is a silent pass: a readback that could not be read is reported as
 * unreadable, and the operator sees that instead of nothing.
 *
 * @param result - The readback graph's return value.
 * @returns The readback, or `undefined` when nothing usable came back.
 */
export function parseReadback(result: unknown): Readback | undefined {
  const state = result as { structuredResponse?: unknown; messages?: unknown[] } | undefined;
  const parsed = readbackSchema.safeParse(state?.structuredResponse);
  if (parsed.success) return parsed.data;

  const last = state?.messages?.[state.messages.length - 1] as { content?: unknown } | undefined;
  const text = typeof last?.content === 'string' ? last.content.trim() : '';
  if (text === '') return undefined;

  return { objective: text, outOfScope: 'not stated', firstAction: 'not stated' };
}

/**
 * Renders a readback as the one line an operator reads while work is waiting.
 *
 * Short on purpose. This is meant to be glanced at, the way a controller hears a
 * readback without stopping to study it; anything longer would be scrolled past,
 * and a readback nobody reads is the same as no readback.
 *
 * @param role - Who is reading the order back.
 * @param readback - What they understood.
 * @returns The line to show.
 */
export function renderReadback(role: string, readback: Readback): string {
  const bounds = readback.outOfScope.trim().toLowerCase().startsWith('nothing')
    ? ''
    : ` · fuera: ${readback.outOfScope}`;

  return `${role} entendió: ${readback.objective}${bounds}\n    Primera acción: ${readback.firstAction}`;
}
