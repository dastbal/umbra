import type { GuardedSubagent } from '../orchestration-policy';

/**
 * Share of a turn's budget granted to each role, and the share held back.
 *
 * The reserve is the part that matters. Without it, a delegate that explores
 * greedily consumes everything and the turn dies with nothing to say: on
 * 2026-08-27 a Researcher spent an entire budget and the run ended on a
 * recursion-limit exception, with no answer and no partial result. A reserve
 * guarantees the orchestrator can always close the turn — with a partial
 * handoff if that is all there is.
 */
export interface BudgetSplit {
  /** Fraction of the pool offered to the Researcher. */
  researcher: number;
  /** Fraction of the pool offered to the Coder. */
  coder: number;
  /** Fraction of the pool offered to the Verifier. */
  verifier: number;
  /** Fraction withheld so the turn can always produce a final answer. */
  reserve: number;
}

/**
 * Default split. The Coder receives the largest share because it writes and
 * re-runs verification; the Verifier the smallest because its work is bounded
 * by two commands.
 *
 * At the default pool of 50 this yields 14 / 18 / 8 with 10 held in reserve.
 */
export const DEFAULT_BUDGET_SPLIT: BudgetSplit = {
  researcher: 0.28,
  coder: 0.36,
  verifier: 0.16,
  reserve: 0.2,
};

/** Identifier of one delegation within a turn, e.g. `coder#2`. */
export type DelegationId = string;

/** A grant made to a single delegation. */
export interface Allocation {
  /** The delegation this grant belongs to. */
  delegationId: DelegationId;
  /** Tool attempts granted. */
  granted: number;
  /** Tool attempts consumed so far. */
  spent: number;
}

/**
 * The turn's single budget, shared by the orchestrator and every subagent.
 *
 * ## Why this exists at all
 *
 * `recursionLimit` looked like a turn budget and is not. `deepagents` spreads
 * the parent's config into the subagent's invocation
 * (`{ ...config, configurable: { ... } }`) and then calls `subagent.invoke`,
 * which starts a **fresh** graph run. Every delegate therefore receives the
 * same numeric limit as a brand-new allowance: a turn configured for 50
 * transitions can actually spend 50 in the orchestrator plus 50 in each
 * delegation.
 *
 * ADR-008 bounded the single-agent path and recorded, as a neutral
 * consequence, that the orchestrated path kept "its separate delegation and
 * retry controls". Those controls bound how many times work is delegated, not
 * what a delegate spends once it starts. This class supplies the missing half.
 *
 * The pool is deliberately a mutable object rather than a value derived from
 * persisted messages: a subagent runs in its own graph with its own message
 * state, invisible to the parent, so there is no shared transcript to count.
 * Ownership and lifetime are handled by `DelegationRegistry`, which scopes one
 * pool to one turn of one thread.
 */
export class BudgetPool {
  private readonly allocations = new Map<DelegationId, Allocation>();
  private readonly split: BudgetSplit;
  private readonly reserved: number;
  private available: number;

  /**
   * @param total - Tool attempts available for the whole turn.
   * @param split - Share of the pool offered to each role.
   */
  public constructor(
    public readonly total: number,
    split: BudgetSplit = DEFAULT_BUDGET_SPLIT,
  ) {
    this.split = split;
    this.reserved = Math.max(1, Math.floor(total * split.reserve));
    this.available = total - this.reserved;
  }

  /**
   * Grants a delegation its share, capped by what the pool can still afford.
   *
   * A grant smaller than the role's nominal share is not an error: it is the
   * turn telling the delegate that earlier work cost more than planned. The
   * delegate is expected to return a partial result rather than to overrun.
   *
   * @param delegationId - Identifier of the delegation being authorized.
   * @param role - Role the grant is sized for.
   * @returns Tool attempts granted; zero when only the reserve remains.
   */
  public allocate(delegationId: DelegationId, role: GuardedSubagent): number {
    const existing = this.allocations.get(delegationId);
    if (existing) return existing.granted;

    const nominal = Math.max(1, Math.floor(this.total * this.split[role]));
    const granted = Math.max(0, Math.min(nominal, this.available));

    this.available -= granted;
    this.allocations.set(delegationId, { delegationId, granted, spent: 0 });
    return granted;
  }

  /**
   * Records tool attempts consumed by a delegation.
   *
   * @param delegationId - The delegation spending its grant.
   * @param amount - Attempts consumed, normally one.
   * @returns Attempts still available to that delegation, never below zero.
   */
  public consume(delegationId: DelegationId, amount = 1): number {
    const allocation = this.allocations.get(delegationId);
    if (!allocation) return 0;

    allocation.spent += amount;
    return Math.max(0, allocation.granted - allocation.spent);
  }

  /**
   * Returns a finished delegation's unused grant to the pool.
   *
   * Without this, a Researcher that finishes early leaves its unspent share
   * stranded and a later correction cycle is refused while the turn still had
   * budget. Retries are affordable precisely because completed work gives back
   * what it did not use.
   *
   * @param delegationId - The delegation that has finished.
   * @returns Attempts returned to the pool.
   */
  public release(delegationId: DelegationId): number {
    const allocation = this.allocations.get(delegationId);
    if (!allocation) return 0;

    const unused = Math.max(0, allocation.granted - allocation.spent);
    allocation.granted = allocation.spent;
    this.available += unused;
    return unused;
  }

  /**
   * Reports whether a delegation has spent everything it was granted.
   *
   * @param delegationId - The delegation to check.
   * @returns Whether the delegate must now return what it has.
   */
  public isExhausted(delegationId: DelegationId): boolean {
    const allocation = this.allocations.get(delegationId);
    return allocation === undefined || allocation.spent >= allocation.granted;
  }

  /** @returns Attempts still grantable, excluding the untouchable reserve. */
  public get grantable(): number {
    return this.available;
  }

  /** @returns Attempts withheld so the turn can always produce an answer. */
  public get reserve(): number {
    return this.reserved;
  }

  /** @returns Attempts consumed across every delegation in this turn. */
  public get spent(): number {
    return [...this.allocations.values()].reduce((sum, one) => sum + one.spent, 0);
  }

  /**
   * Produces a privacy-safe summary for telemetry.
   *
   * Contains counts only — no prompts, no arguments, no file contents — so it
   * can be joined to a LangSmith trace under the same rules ADR-008 set for
   * `TurnAudit`.
   *
   * @returns Per-delegation grants and spend for the current turn.
   */
  public describe(): { total: number; reserve: number; grantable: number; allocations: Allocation[] } {
    return {
      total: this.total,
      reserve: this.reserved,
      grantable: this.available,
      allocations: [...this.allocations.values()].map((one) => ({ ...one })),
    };
  }
}

/** A delegation that consumed more than it was granted. */
export interface BudgetDiscrepancy {
  /** The delegation whose books do not balance. */
  delegationId: DelegationId;
  /** What the turn granted it. */
  granted: number;
  /** What it actually consumed. */
  spent: number;
}

/**
 * Reports every delegation that spent more than it was granted.
 *
 * ## Why the books are kept twice
 *
 * What Luca Pacioli published in 1494 was not the idea of writing transactions
 * down. It was writing each one **twice**, in two places that must agree, so
 * that an error stops hiding and starts announcing itself as an imbalance.
 *
 * This pool keeps both halves. The grant is written when a delegation is
 * authorized; the spend is written by the delegate's own middleware, one entry
 * per tool attempt. Nothing should ever be able to make the second exceed the
 * first, because the middleware refuses the attempt that would.
 *
 * So an imbalance is not a rounding difference — it means something consumed the
 * turn's budget through a door this project did not open. That is not
 * hypothetical: `docs/deferred-work.md` records deepagents' filesystem
 * middleware handing subagents tools the harness had excluded, and a delegation
 * dying on one. Owning the subagent graphs closed that particular door; this
 * reports the next one instead of waiting for a run to fail on it.
 *
 * @returns The delegations whose books do not balance, empty when they do.
 */
export function reconcile(pool: BudgetPool): BudgetDiscrepancy[] {
  return pool
    .describe()
    .allocations
    .filter((allocation) => allocation.spent > allocation.granted)
    .map(({ delegationId, granted, spent }) => ({ delegationId, granted, spent }));
}

/**
 * Describes an imbalance for an operator and for telemetry.
 *
 * Counts only, no prompts and no arguments, so it can be joined to a LangSmith
 * trace under the rules ADR-008 set for `TurnAudit`.
 *
 * @param discrepancies - What {@link reconcile} found.
 * @returns A line to report, or `undefined` when the books balance.
 */
export function describeDiscrepancies(
  discrepancies: readonly BudgetDiscrepancy[],
): string | undefined {
  if (discrepancies.length === 0) return undefined;

  const detail = discrepancies
    .map((one) => `${one.delegationId} spent ${one.spent} of ${one.granted}`)
    .join('; ');

  return `Budget books do not balance: ${detail}. `
    + 'Something consumed the turn budget outside the granted allowance.';
}
