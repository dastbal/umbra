import { z } from 'zod';
import { tool } from '@langchain/core/tools';
import { getConfig, getCurrentTaskInput } from '@langchain/langgraph';
import {
  LanePromotionError,
  promoteLane,
  readLane,
  type RouteLane,
} from '../../agent/route-lane';
import { readPromotion, recordPromotion } from '../../agent/lane-registry';
import { readTurnKey } from '../../agent/orchestration-guard.middleware';
import { log } from '../utils/logger';

/**
 * Lets a turn ask to be raised into a lane where it may change files.
 *
 * ## Why a turn can change lane at all
 *
 * Triage sorts an arriving message by what an error costs, and sorts anything it
 * does not recognise **down**. That is only honest if the low lane is not a dead
 * end: a request the vocabulary failed to recognise — "el login está roto" —
 * starts in the reading lane and would otherwise be stuck there, able to explain
 * the bug and never to fix it.
 *
 * This is the second sort. The door decides cheaply and coarsely; the agent that
 * has now actually read the code decides finely, and says why. It is the same
 * shape as a triage nurse assigning a class at the entrance and a doctor
 * revising it in the ward, and it is what makes the vocabulary an optimization
 * instead of a decision: a gap costs one tool call, not a wrong turn.
 *
 * ## What it cannot do
 *
 * It cannot raise a message that asked for nothing. A greeting has nothing to
 * escalate, so no chain of reasoning can walk it to the disk. It cannot run
 * twice in a turn, so a model cannot climb lane by lane. And it cannot run
 * without a reason, because the reason is the whole audit trail.
 */
export const escalateRouteTool = tool(
  async ({ reason }: { reason: string }) => {
    const scope = readScope();
    if (!scope) {
      return 'No route is in force for this turn, so there is no lane to raise.';
    }

    const { threadId, turnKey, lane } = scope;
    const previous = readPromotion(threadId, turnKey);

    try {
      const promotion = promoteLane(
        previous?.lane ?? lane,
        'change',
        reason,
        previous !== undefined,
      );

      if (!promotion.raised) return promotion.reason;

      recordPromotion(threadId, turnKey, { lane: promotion.lane, reason: promotion.reason });
      log.sys(`route raised to ${promotion.lane}: ${promotion.reason}`);

      return `Route raised to the ${promotion.lane} lane. Reason recorded: ${promotion.reason}. `
        + 'You may now delegate to the coder. Say plainly, in your final answer, that you '
        + 'changed files and why.';
    } catch (error: unknown) {
      if (error instanceof LanePromotionError) return error.message;
      throw error;
    }
  },
  {
    name: 'escalate_route',
    description:
      'Ask to move this turn into the lane where files may be changed. '
      + 'Use it when you have read enough to know the request needs a code change and the '
      + 'route you were given does not allow one. State what the work turned out to require. '
      + 'Once per turn, and never for a message that asked for no work.',
    schema: z.object({
      reason: z
        .string()
        .describe('What the work turned out to require, in one sentence.'),
    }),
  },
);

interface LaneScope {
  threadId: string;
  turnKey: string;
  lane: RouteLane;
}

/**
 * Finds the turn being escalated and the lane it currently runs in.
 *
 * The lane is read from the routing envelope in the turn's own messages, which
 * is where it was recorded, rather than from anything this tool is told.
 */
function readScope(): LaneScope | undefined {
  const configurable = safeConfig()?.['configurable'] as Record<string, unknown> | undefined;
  const threadId = configurable?.['thread_id'];
  if (typeof threadId !== 'string') return undefined;

  const messages = readMessages();
  if (messages.length === 0) return undefined;

  return { threadId, turnKey: readTurnKey(messages), lane: readLane(envelopeText(messages)) };
}

function envelopeText(messages: readonly unknown[]): string {
  return messages
    .map((message) => {
      const content = (message as { content?: unknown } | undefined)?.content;
      return typeof content === 'string' ? content : '';
    })
    .join('\n');
}

function readMessages(): readonly unknown[] {
  try {
    const state = getCurrentTaskInput() as { messages?: unknown } | undefined;
    return Array.isArray(state?.messages) ? state.messages : [];
  } catch {
    return [];
  }
}

function safeConfig(): Record<string, unknown> | undefined {
  try {
    return getConfig() as unknown as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
