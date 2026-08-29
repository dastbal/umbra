import { z } from 'zod';
import { tool } from '@langchain/core/tools';
import { ToolMessage } from '@langchain/core/messages';
import { Command, getConfig, getCurrentTaskInput } from '@langchain/langgraph';
import { currentTurn } from './delegation-registry';
import { renderMandate } from './mandate';
import { toParentUpdate, toSubagentState } from './state-bridge';
import type { SubagentGraphs } from './subagent-registry';
import {
  asReadbackOrder,
  parseReadback,
  renderReadback,
  type ReadbackGraphs,
} from './readback';
import { requestApproval, rethrowIfSuspension } from '../../tools/utils/approval';
import { log } from '../../tools/utils/logger';

/**
 * The delegation order, as arguments the provider itself validates.
 *
 * ## Why the schema is the mandate
 *
 * `deepagents`' `task` accepts exactly `description` and `subagent_type`, so an
 * order had nowhere to live and was serialized by the model into a string that
 * this project then parsed back. Every delegation failure of 2026-08-27 was a
 * variant of that: a bare instruction with no context; then the order flattened
 * into the call, which dropped `subagent_type` and ended the session twice. Each
 * one was answered with more tolerance in the parser, and the next variant was
 * already visible — a field named `user_request`, the order written in two
 * places at once, a comment inside the JSON.
 *
 * The mechanism borrowed here is railway interlocking (Saxby, 1856). Before it,
 * a signalman had loose levers and a list of rules — *do not clear the signal
 * while the points are set against it* — and trains still collided. Interlocking
 * did not write a better rule: it bolted the levers to each other, so an unsafe
 * route stopped being something to detect and became something that cannot be
 * expressed.
 *
 * These fields are those bolts. A flattened order is not a mistake here, because
 * flattened **is** the shape. A missing subagent is refused by the provider at
 * the function-calling layer, where a model retries against a schema instead of
 * being handed a diagnosis by us.
 */
const delegateSchema = z.object({
  subagent: z.string().min(1).describe('Who carries out this delegation.'),
  userRequest: z
    .string()
    .describe('The request of the user, copied word for word. Never a paraphrase.'),
  objective: z
    .string()
    .describe('What this delegate must achieve, in your words.'),
  knownContext: z
    .array(z.string())
    .describe('What you already know, so the delegate does not rediscover it.'),
  inScope: z
    .array(z.string())
    .describe('The work that belongs to this delegation.'),
  outOfScope: z
    .array(z.string())
    .optional()
    .describe('What must NOT be explored. This is the field that bounds the cost.'),
  definitionOfDone: z
    .string()
    .describe('The artifact you expect back.'),
  conventions: z
    .array(z.string())
    .optional()
    .describe('Project rules and decision records that constrain the work.'),
});

/** The order the orchestrator writes, exactly as the provider validates it. */
export type DelegateInput = z.infer<typeof delegateSchema>;

/**
 * Creates the delegation tool.
 *
 * The tool dispatches; it does not decide. Whether this delegation is permitted,
 * what budget it receives and whether its order carries enough context are the
 * orchestration guard's job, and it has already answered all three by the time
 * this runs — the mandate it recorded is what this reads.
 *
 * @param graphs - The compiled delegates, from `buildSubagentGraphs`.
 * @returns The `delegate` tool, ready to declare on the orchestrator.
 */
export function createDelegateTool(graphs: SubagentGraphs, readbacks?: ReadbackGraphs) {
  const registeredRoles = Object.keys(graphs);
  const schema = delegateSchema.superRefine((input, ctx) => {
    if (!registeredRoles.includes(input.subagent)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['subagent'],
        message: `Unknown subagent '${input.subagent}'. Registered roles: ${registeredRoles.join(', ')}.`,
      });
    }
  });

  return tool(
    async (input: DelegateInput) => {
      const scope = readScope();
      if (!scope) {
        return 'No delegation is in force for this turn, so there is nobody to delegate to. '
          + 'Answer with what you have established.';
      }

      const { ledger, delegationId, toolCallId } = scope;
      const mandate = ledger.mandates.get(delegationId);
      if (!mandate) {
        return 'This delegation carries no recorded order. Issue it again.';
      }

      const order = renderMandate(mandate) + inheritedFindings(ledger.findings);
      const parentState = readParentState();

      const refusal = await readBackTheOrder(readbacks, input.subagent, order);
      if (refusal) return refusal;

      log.sys(`delegate → ${input.subagent} (${delegationId}), ${mandate.budget.toolCalls} attempts`);

      const graph = graphs[input.subagent];
      if (graph === undefined) return `No graph is registered for '${input.subagent}'.`;
      const result = await graph.invoke(
        toSubagentState(parentState, order),
        getConfig(),
      );

      const { update, content } = toParentUpdate(result);

      // A Command carries the delegate's state back into the orchestrator, which
      // is what keeps the shared workspace shared. Without a tool call id there
      // is nothing to answer, so the text stands alone.
      if (toolCallId === undefined) return content;

      return new Command({
        update: {
          ...update,
          messages: [new ToolMessage({ content, tool_call_id: toolCallId, name: 'delegate' })],
        },
      });
    },
    {
      name: 'delegate',
      description:
        'Hand work to a specialist. Every field is part of the order the delegate receives: '
        + 'it cannot see this conversation, so whatever you leave out, it cannot look up. '
        + 'researcher analyzes and plans, coder implements, verifier checks.',
      schema,
    },
  );
}

/**
 * Has the delegate read its order back before any work begins.
 *
 * The aviation loop: a clearance is given when the pilot reads it back and the
 * controller hears it. Routine clearances are read back and acted on; crossing a
 * runway waits for confirmation. The Coder writes to disk, so it waits.
 *
 * A readback that cannot be produced does not block the delegation — the channel
 * is a check on understanding, not another way for a turn to die — but it is
 * reported, because a check nobody can see is not a check.
 *
 * @returns A refusal to hand back, or `undefined` to proceed.
 */
async function readBackTheOrder(
  readbacks: ReadbackGraphs | undefined,
  role: string,
  order: string,
): Promise<string | undefined> {
  if (!readbacks) return undefined;

  let readback;
  try {
    const graph = readbacks[role];
    if (graph === undefined) return `No readback graph is registered for '${role}'.`;
    readback = parseReadback(await graph.invoke(
      { messages: [{ role: 'human', content: asReadbackOrder(order) }] },
      getConfig(),
    ));
  } catch (error: unknown) {
    rethrowIfSuspension(error);
    log.sys(`${role} could not read its order back; proceeding without one`);
    return undefined;
  }

  if (!readback) {
    log.sys(`${role} returned no readable readback; proceeding without one`);
    return undefined;
  }

  log.sys(`↩ ${renderReadback(role, readback)}`);

  // Crossing the runway. Only the delegate that writes waits for a human.
  if (role !== 'coder') return undefined;

  const approved = requestApproval(
    'delegate',
    { subagent: role, understood: readback.objective, firstAction: readback.firstAction },
    'The coder is about to change files. Confirm it understood the order.',
  );

  return approved
    ? undefined
    : `The operator did not confirm this delegation. The coder understood: "${readback.objective}". `
      + 'Do not delegate it again unchanged — report what was refused, or issue a corrected order.';
}

/**
 * Renders what earlier delegates established in this turn.
 *
 * The cheapest budget saving available: it costs nothing to hand over, and it is
 * the difference between a second delegate confirming a finding and repeating
 * the investigation that produced it.
 */
function inheritedFindings(findings: readonly string[]): string {
  if (findings.length === 0) return '';

  return '\n\n## Already established this turn — inherit it, do not re-verify\n\n'
    + findings.map((finding) => `- ${finding}`).join('\n');
}

interface DelegationScope {
  ledger: NonNullable<ReturnType<typeof currentTurn>>;
  delegationId: string;
  toolCallId?: string;
}

/**
 * Finds the delegation the guard authorized for this call.
 *
 * The tool carries no identity of its own: the guard mints the delegation, grants
 * its budget and records the mandate before handing control here.
 */
function readScope(): DelegationScope | undefined {
  const config = safeConfig();
  const configurable = config?.['configurable'] as Record<string, unknown> | undefined;
  const threadId = configurable?.['thread_id'];
  if (typeof threadId !== 'string') return undefined;

  const ledger = currentTurn(threadId);
  if (!ledger?.activeDelegationId) return undefined;

  const toolCall = config?.['toolCall'] as { id?: unknown } | undefined;

  return {
    ledger,
    delegationId: ledger.activeDelegationId,
    toolCallId: typeof toolCall?.id === 'string' ? toolCall.id : undefined,
  };
}

/**
 * Reads the orchestrator state the delegate inherits.
 *
 * Outside a graph run there is no state, and a delegation with an empty
 * workspace is still a valid delegation — so this reports nothing rather than
 * failing.
 */
function readParentState(): unknown {
  try {
    return getCurrentTaskInput();
  } catch {
    return undefined;
  }
}

function safeConfig(): Record<string, unknown> | undefined {
  try {
    return getConfig() as unknown as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
