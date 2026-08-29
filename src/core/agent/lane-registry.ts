import type { RouteLane } from './route-lane';

/** A lane raised during one turn, and the reason given for raising it. */
export interface RecordedPromotion {
  /** The lane the turn was raised to. */
  lane: RouteLane;
  /** Why the work turned out to need it. */
  reason: string;
}

/**
 * Promotions granted per turn.
 *
 * Kept apart from the delegation ledger on purpose. That ledger exists to hold a
 * turn's budget and its mandates, and it is opened by the orchestration guard at
 * the moment of a delegation — which is exactly the moment a turn on the reading
 * lane never reaches. An agent that discovers it must write has to be able to say
 * so *before* any delegation exists, so the record of that cannot live inside
 * one.
 *
 * Bounded the same way and for the same reason: one entry per thread, replaced
 * when the thread starts a new turn.
 */
const promotions = new Map<string, { turnKey: string; promotion: RecordedPromotion }>();

/** Threads whose promotion is retained simultaneously. */
export const MAX_TRACKED_LANE_THREADS = 32;

/**
 * Records that a turn was raised into a higher lane.
 *
 * @param threadId - Conversation thread the turn belongs to.
 * @param turnKey - Stable identifier of the turn within that thread.
 * @param promotion - The lane granted and the reason for it.
 */
export function recordPromotion(
  threadId: string,
  turnKey: string,
  promotion: RecordedPromotion,
): void {
  promotions.set(threadId, { turnKey, promotion });
  while (promotions.size > MAX_TRACKED_LANE_THREADS) {
    const oldest = promotions.keys().next();
    if (oldest.done) return;
    promotions.delete(oldest.value);
  }
}

/**
 * Reads the promotion granted to a thread's current turn.
 *
 * A promotion belongs to the turn that earned it. When the thread has moved on,
 * this reports nothing — which is what makes "once per turn" mean once per turn
 * rather than once per session.
 *
 * @param threadId - Conversation thread to look up.
 * @param turnKey - The turn being asked about.
 * @returns The promotion, or `undefined` when this turn has none.
 */
export function readPromotion(
  threadId: string | undefined,
  turnKey: string,
): RecordedPromotion | undefined {
  if (threadId === undefined) return undefined;

  const entry = promotions.get(threadId);
  return entry?.turnKey === turnKey ? entry.promotion : undefined;
}

/** Discards every retained promotion. Exported for tests and process resets. */
export function resetLaneRegistry(): void {
  promotions.clear();
}
