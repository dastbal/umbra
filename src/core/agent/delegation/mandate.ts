import { z } from 'zod';

/**
 * The part of a delegation order the orchestrator writes.
 *
 * Everything here is knowledge only the orchestrator has. The budget is not:
 * it is granted by the turn's pool, so it is deliberately absent from what the
 * model produces — a model that could set its own allowance would not be
 * bounded by one.
 */
export interface MandateOrder {
  /**
   * The user's request, verbatim.
   *
   * Never a paraphrase. The orchestrator's reading of the request belongs in
   * `objective`; both travel, because a delegate that disagrees with the
   * paraphrase can only notice by seeing the original.
   */
  userRequest: string;
  /** What the orchestrator understands the delegate must achieve. */
  objective: string;
  /**
   * What the orchestrator already knows and the delegate would otherwise have
   * to rediscover: route classification, prior artifacts, findings from
   * earlier delegations in the same turn.
   */
  knownContext: string[];
  /** The work that belongs to this delegation. */
  inScope: string[];
  /**
   * The work that explicitly does not belong to this delegation.
   *
   * This is the field that bounds exploration. A delegate told that the
   * project's general architecture is settled does not spend its budget
   * re-deriving it.
   */
  outOfScope: string[];
  /** The output contract the delegate is expected to satisfy. */
  definitionOfDone: string;
  /** Project conventions and decision records that constrain the work. */
  conventions: string[];
}

/**
 * The complete order handed to a subagent when work is delegated.
 *
 * ## Why this type exists
 *
 * `deepagents` replaces a subagent's message history with a single human
 * message built from the `description` argument of the `task` tool
 * (`subagentState.messages = [new HumanMessage({ content: description })]`).
 * A subagent therefore sees **nothing** of the conversation that produced its
 * assignment: not the user's request, not what the orchestrator already
 * discovered, not the boundaries of the job.
 *
 * That is not a stylistic gap, it is the whole channel. A delegation observed
 * on 2026-08-27 sent the Researcher the string
 * `"List all files in the skills/ directory"` while the user had asked to
 * review and improve those skills. The Researcher, unable to see the real
 * request, swept the codebase — architecture, modules, repositories, DTOs,
 * error handling, authentication — and died at the recursion limit without
 * producing a handoff.
 *
 * A `Mandate` is the payload that makes that channel sufficient: it is
 * rendered into `description`, so everything the delegate needs travels with
 * the order instead of being reconstructed by guessing.
 */
export interface Mandate extends MandateOrder {
  /** Resources this delegation may consume, granted by the turn's pool. */
  budget: MandateBudget;
}

/** The resources a single delegation is allowed to spend. */
export interface MandateBudget {
  /** Tool attempts allotted to the delegate from the turn's pool. */
  toolCalls: number;
  /** Questions the delegate may ask before it must answer with what it has. */
  questions: number;
}

/** Runtime validator for the part of the order the orchestrator writes. */
export const mandateOrderSchema = z.object({
  userRequest: z.string().trim().min(1),
  objective: z.string().trim().min(1),
  knownContext: z.array(z.string().trim().min(1)).min(1),
  inScope: z.array(z.string().trim().min(1)).min(1),
  outOfScope: z.array(z.string().trim().min(1)).default([]),
  definitionOfDone: z.string().trim().min(1),
  conventions: z.array(z.string().trim().min(1)).default([]),
});

/** Runtime validator for a delegation order including its granted budget. */
export const mandateSchema = mandateOrderSchema.extend({
  budget: z.object({
    toolCalls: z.number().int().positive(),
    questions: z.number().int().min(0),
  }),
});

/** Signals a delegation that was ordered without the context to carry it out. */
export class IncompleteMandateError extends Error {
  /** Field paths that failed the completeness gate. */
  public readonly missing: readonly string[];

  /**
   * @param missing - Field paths that were absent or empty.
   */
  public constructor(missing: readonly string[]) {
    super(
      `Delegation refused: the mandate is incomplete (${missing.join(', ')}). `
      + `A subagent sees only what this mandate carries — it cannot read the conversation, `
      + `the user's request, or anything discovered earlier in this turn. `
      + `Supply the missing fields and delegate again.`,
    );
    this.name = 'IncompleteMandateError';
    this.missing = missing;
  }
}

/**
 * Rejects a delegation whose order lacks the context to be carried out.
 *
 * ## Which fields are required, and why not all of them
 *
 * Required: `userRequest`, `objective`, `definitionOfDone`, and at least one
 * entry in `knownContext` and `inScope`. Those are the fields a delegate
 * cannot substitute by working harder — no amount of searching recovers what
 * the user actually asked for.
 *
 * `outOfScope` and `conventions` are deliberately **not** required, though
 * `outOfScope` is the field that most reduces wasted exploration. Requiring
 * every useful field produces fabricated ones: a model forced to fill
 * `outOfScope` on a delegation with no real exclusions invents an exclusion,
 * and an invented boundary is worse than an absent one because the delegate
 * obeys it. The gate enforces what cannot be recovered; the prompt encourages
 * the rest.
 *
 * @param order - The order the orchestrator wants to issue.
 * @throws {IncompleteMandateError} When a required field is absent or empty.
 */
export function assertMandateComplete(order: unknown): asserts order is MandateOrder {
  const result = mandateOrderSchema.safeParse(order);
  if (result.success) return;

  const missing = result.error.issues.map((issue) => issue.path.join('.') || '(root)');
  throw new IncompleteMandateError([...new Set(missing)]);
}

/**
 * Reads a delegation order out of the text the orchestrator produced.
 *
 * ## Why the order arrives as text at all
 *
 * The `task` tool's schema belongs to `deepagents` and accepts exactly
 * `description` and `subagent_type`. There is no field to add, so a structured
 * order has to travel inside `description`. JSON is what a model emits most
 * reliably inside a string field, which is why the orchestrator is asked for
 * JSON and the delegate is handed {@link renderMandate}'s prose instead: the
 * guard translates between the two.
 *
 * Parsing is tolerant of what models actually emit — a fenced block, a fence
 * with a language tag, or a bare object — and tolerant of prose around it. It
 * is not tolerant of a missing field: that is {@link assertMandateComplete}'s
 * job, and a lenient gate there would defeat the whole mechanism.
 *
 * @param description - The `description` argument of a `task` call.
 * @returns The parsed order, or `undefined` when no JSON object was found.
 */
export function parseMandateOrder(description: unknown): unknown | undefined {
  // Some models put the order in `description` as an object rather than as a
  // JSON string. Both are the same order; only the serialization differs.
  if (isRecord(description)) return description;
  if (typeof description !== 'string') return undefined;

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(description);
  const candidate = fenced?.[1]?.trim() ?? extractFirstObject(description);
  if (candidate === undefined) return undefined;

  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

/**
 * Recovers an order a model wrote as arguments of `task` instead of inside
 * `description`.
 *
 * Observed live on 2026-08-27 with `gemini-2.5-flash-lite`: instructed to put a
 * JSON object into `description`, it read the field list as the argument list
 * and called `task` with `userRequest`, `objective`, `knownContext`, `inScope`,
 * `outOfScope`, `definitionOfDone` and `description` at the top level — and, in
 * flattening them, dropped `subagent_type` entirely.
 *
 * The order it wrote was complete and correct. Refusing it over where the model
 * put it would be pedantry paid for by the operator, so the guard reads it from
 * either place. The prompt still asks for the nested form, because only that one
 * survives a schema the provider actually validates.
 *
 * @param args - The arguments supplied to `task`.
 * @returns The order found at the top level, or `undefined` when there is none.
 */
export function readFlattenedOrder(args: unknown): unknown | undefined {
  if (!isRecord(args)) return undefined;
  if (!('userRequest' in args) || !('objective' in args)) return undefined;

  const keys: (keyof MandateOrder)[] = [
    'userRequest', 'objective', 'knownContext', 'inScope',
    'outOfScope', 'definitionOfDone', 'conventions',
  ];
  const order: Record<string, unknown> = {};
  for (const key of keys) if (key in args) order[key] = args[key];
  return order;
}

/**
 * The order template shown to the orchestrator when its mandate is unusable.
 *
 * Returned as a tool result rather than thrown, so the orchestrator can repair
 * the order and delegate again. A thrown error ends the turn — which is
 * correct for a protocol violation the model cannot fix, and wrong for a
 * message it can simply rewrite.
 */
export const MANDATE_TEMPLATE = `{
  "userRequest": "<the user's request, copied word for word>",
  "objective": "<what this delegate must achieve>",
  "knownContext": ["<what you already know, so it is not rediscovered>"],
  "inScope": ["<what belongs to this delegation>"],
  "outOfScope": ["<what must not be explored — this is what bounds the cost>"],
  "definitionOfDone": "<the artifact you expect back>",
  "conventions": ["<project rules and decision records that constrain the work>"]
}`;

/**
 * Renders a mandate into the single string a subagent will receive.
 *
 * The format is prose with headed sections rather than the JSON the
 * orchestrator wrote: the consumer is a language model reading its only human
 * message, and headed prose is what it follows. The structured original stays
 * in the turn ledger, so nothing depends on parsing this text back.
 *
 * @param mandate - A validated order plus its granted budget.
 * @returns The `description` payload for the `task` tool.
 */
export function renderMandate(mandate: Mandate): string {
  const sections: string[] = [
    `## The user's request, verbatim\n\n${mandate.userRequest}`,
    `## Your objective\n\n${mandate.objective}`,
    `## What is already known — do not rediscover this\n\n${bullets(mandate.knownContext)}`,
    `## In scope\n\n${bullets(mandate.inScope)}`,
  ];

  if (mandate.outOfScope.length > 0) {
    sections.push(`## Out of scope — do not spend budget here\n\n${bullets(mandate.outOfScope)}`);
  }
  if (mandate.conventions.length > 0) {
    sections.push(`## Constraints that must hold\n\n${bullets(mandate.conventions)}`);
  }

  sections.push(`## Definition of done\n\n${mandate.definitionOfDone}`);
  sections.push(
    `## Budget\n\n`
    + `You have ${mandate.budget.toolCalls} tool attempts and ${mandate.budget.questions} questions.\n`
    + `If something in this order is unclear, call ask_delegator instead of guessing.\n`
    + `Running out is not a failure: return what you have with status "partial", listing what stayed unknown. `
    + `Never invent a finding to fill the contract.`,
  );

  return sections.join('\n\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractFirstObject(text: string): string | undefined {
  const start = text.indexOf('{');
  if (start === -1) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const character = text[index];

    if (escaped) { escaped = false; continue; }
    if (character === '\\') { escaped = true; continue; }
    if (character === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }

  return undefined;
}

function bullets(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join('\n');
}
