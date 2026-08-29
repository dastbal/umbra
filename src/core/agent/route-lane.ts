import {
  asksForNothing,
  classifySmallTalk,
  isImplementationRequest,
  isQuestion,
  isReadOnlyRequest,
} from './task-classifier';

/**
 * What a turn is allowed to do, ordered by what an error costs.
 *
 * - `answer` — no tools at all. A wrong answer costs a sentence.
 * - `read` — tools that observe. A wrong read costs tokens.
 * - `change` — the Coder may write. A wrong change costs money and the
 *   repository.
 */
export type RouteLane = 'answer' | 'read' | 'change';

/** The lanes in order of what being wrong in them costs. */
export const LANE_ORDER: readonly RouteLane[] = ['answer', 'read', 'change'];

/**
 * Sorts an arriving message into the lane where being wrong is survivable.
 *
 * ## Why sorting, not classifying
 *
 * The previous classifier tried to recognise intent from vocabulary, and every
 * miss was a wrong route for the whole turn. It missed. On 2026-08-28 the word
 * "maestro" matched no pattern, fell through to the implementation default, and
 * a greeting cost 27 calls, 677.8k tokens, $0.0729 and a file written to disk.
 * The repair was more vocabulary, which is the same bet placed again.
 *
 * The mechanism borrowed instead is triage, as Dominique Larrey organised it for
 * Napoleon's field surgeons in 1793. A surgeon at the door does not diagnose —
 * there is no time and no information. He sorts into a few classes **by what
 * happens if he is wrong**, and an uncertain case goes to the class where being
 * wrong is survivable.
 *
 * So: vocabulary still runs, but only as a fast path for the obvious. Anything
 * it does not recognise sorts **down**, never up. A missing verb no longer means
 * a wrong route; it means a turn that starts one lane low and asks to be raised.
 *
 * That inversion is what makes the word lists stop mattering. They became an
 * optimization — a recognised verb saves one tool call — instead of a decision.
 * A new language costs nothing, and a gap in a list costs a round trip.
 *
 * @param request - Raw interactive user request.
 * @returns The lane this message starts in.
 */
export function triage(request: string): RouteLane {
  // An affirmation means *carry on with what was proposed*, which is a request
  // to keep doing whatever the previous turn was doing. Sorting it down would
  // refuse work the operator just approved (ADR-020).
  if (isAffirmation(request)) return 'change';

  // The fast path: an unmistakable request to change something starts where it
  // is going, and skips a promotion round trip.
  if (isImplementationRequest(request)) return 'change';

  if (classifySmallTalk(request) !== null || asksForNothing(request)) return 'answer';

  // A question wants an answer, and reading is how one is found. Everything the
  // vocabulary failed to recognise arrives here too — deliberately, because this
  // is the lane where being wrong is merely expensive in tokens.
  if (isQuestion(request) || isReadOnlyRequest(request)) return 'read';

  return 'read';
}

/** Signals an attempt to move a turn into a lane it may not enter. */
export class LanePromotionError extends Error {
  /** @param reason - Why the promotion was refused. */
  public constructor(reason: string) {
    super(reason);
    this.name = 'LanePromotionError';
  }
}

/** The outcome of asking to raise a turn's lane. */
export interface LanePromotion {
  /** The lane the turn now runs in. */
  lane: RouteLane;
  /** Whether the request changed anything. */
  raised: boolean;
  /** What the operator and the audit trail are told. */
  reason: string;
}

/**
 * Raises a turn's lane, once, for a stated reason.
 *
 * ## Why a turn can change lane at all
 *
 * The route used to be decided before the model saw the message and could never
 * be revised, so a misread message stayed misread for the whole turn. Promotion
 * is what removes the need to guess correctly the first time: an agent that
 * discovers it must write says so, names why, and the turn moves up.
 *
 * Three rules keep it from becoming a way around the triage:
 *
 * - **Only upward, and only once.** A turn that has already been raised cannot
 *   be raised again, so a model cannot walk itself up lane by lane.
 * - **A reason is required.** A promotion with nothing to say is refused, which
 *   is what makes the audit trail worth reading.
 * - **`answer` is not a floor to climb from.** A message that asked for nothing
 *   cannot become a request to write, because nothing in it ever asked. That is
 *   the rule that keeps a greeting from reaching the disk.
 *
 * @param current - The lane the turn is in.
 * @param requested - The lane being asked for.
 * @param reason - Why the work turned out to need it.
 * @param alreadyPromoted - Whether this turn has been raised before.
 * @returns The resulting lane and what to report.
 * @throws {LanePromotionError} When the move is not permitted.
 */
export function promoteLane(
  current: RouteLane,
  requested: RouteLane,
  reason: string,
  alreadyPromoted: boolean,
): LanePromotion {
  const trimmed = reason.trim();

  if (trimmed === '') {
    throw new LanePromotionError(
      'A lane promotion needs a reason. State what the work turned out to require.',
    );
  }

  if (current === 'answer') {
    throw new LanePromotionError(
      'This message asked for no work, so there is nothing to escalate. '
      + 'Answer it, and let the operator ask for the work if they want it.',
    );
  }

  if (alreadyPromoted) {
    throw new LanePromotionError(
      'This turn has already been escalated once. Finish within the lane you were given, '
      + 'or report what remains and let the operator decide.',
    );
  }

  if (rank(requested) <= rank(current)) {
    return { lane: current, raised: false, reason: `Already running in the ${current} lane.` };
  }

  return { lane: requested, raised: true, reason: trimmed };
}

/** Reports whether a lane permits the Coder to write. */
export function laneAllowsWrites(lane: RouteLane): boolean {
  return lane === 'change';
}

/** Reports whether a lane permits any tool at all. */
export function laneAllowsTools(lane: RouteLane): boolean {
  return lane !== 'answer';
}

/**
 * Reads a lane out of a routing envelope.
 *
 * Tolerates an envelope written before lanes existed: `implementation=true`
 * meant the change lane and `implementation=false` meant read. A checkpoint
 * recorded by an earlier version must not be read as a lane it never chose.
 *
 * @param envelope - The envelope text, or any text containing it.
 * @returns The lane the envelope declares.
 */
export function readLane(envelope: string): RouteLane {
  const explicit = /lane=(answer|read|change)/.exec(envelope);
  if (explicit) return explicit[1] as RouteLane;

  if (envelope.includes('implementation=false]')) return 'read';
  return 'change';
}

function rank(lane: RouteLane): number {
  return LANE_ORDER.indexOf(lane);
}

/** Affirmations mean *proceed*, and are the one input that starts at the top. */
function isAffirmation(request: string): boolean {
  return AFFIRMATION.test(request.trim());
}

const AFFIRMATION = new RegExp(
  '^[¿¡\\s]*(ok(ay)?|dale|listo|s[ií]|yes|yep|sure|perfecto|genial|segu[ií]|continu[áa]|'
  + 'adelante|hazlo|hacelo|go( ahead)?)[!?.\\s]*$',
  'i',
);
