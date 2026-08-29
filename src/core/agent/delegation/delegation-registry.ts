import { BudgetPool, type BudgetSplit, type DelegationId } from './budget-pool';
import type { Mandate } from './mandate';

/**
 * Everything one interactive turn shares between the orchestrator and the
 * subagents it delegates to.
 *
 * ## Why a mutable ledger and not persisted state
 *
 * `deepagents` shares part of the graph state with a subagent — everything
 * except `messages`, `todos`, `structuredResponse`, `skillsMetadata` and
 * `memoryContents` — and merges the subagent's state back into the parent when
 * it returns. That channel is real and this design uses it for file-shaped
 * work: the virtual filesystem under the `files` key is a genuine shared
 * workspace, already bidirectional, and previously unused by this project.
 *
 * What that channel cannot carry is the live accounting a delegation needs
 * *while it runs*: how much budget is left, which questions were already
 * answered, what earlier delegates found. Those are read and written mid-run,
 * by a graph whose message state the parent cannot see. So they live here, in
 * a process-local ledger keyed by thread and turn, and the graph state keeps
 * carrying the artifacts.
 */
export interface DelegationLedger {
  /** The thread this turn belongs to. */
  readonly threadId: string;
  /** Identifies the turn within the thread; a new turn replaces the ledger. */
  readonly turnKey: string;
  /** The single budget shared by the orchestrator and its delegates. */
  readonly pool: BudgetPool;
  /** Orders issued this turn, by delegation. */
  readonly mandates: Map<DelegationId, Mandate>;
  /**
   * Findings accumulated by delegates that already ran.
   *
   * This is what makes a retry cheaper than the attempt it replaces, and what
   * the broker answers a delegate's question from before escalating.
   */
  readonly findings: string[];
  /** Questions asked per delegation, counted against the mandate's allowance. */
  readonly questionsAsked: Map<DelegationId, number>;
  /** Delegations opened per role, used to mint identifiers. */
  readonly delegationCounts: Map<string, number>;
  /**
   * The delegation currently running, or `undefined` between delegations.
   *
   * A subagent knows nothing about the ledger: it runs in its own graph and
   * receives only its rendered order. So the components that act on its behalf
   * — its budget middleware and `ask_delegator` — find out which delegation
   * they belong to by reading this pointer, which the orchestration guard sets
   * before handing control over and clears when the delegate returns.
   *
   * A single pointer is sufficient because nested delegation is disabled
   * (`maxDelegationDepth: 1`) and the orchestrator delegates one subagent at a
   * time. Should parallel delegation ever be enabled, this must become a
   * per-run association or the two delegates will spend each other's budget.
   */
  activeDelegationId?: DelegationId;
  /**
   * The lane this turn was raised to, and why.
   *
   * Recorded rather than merely applied: a turn that changed what it is allowed
   * to do should say so in the audit trail, and the reason is what makes that
   * trail worth reading.
   */
  promotedLane?: string;
  /** Why the turn was raised. */
  promotionReason?: string;
}

/**
 * Process-local store of the current turn of each thread.
 *
 * Bounded on purpose: one entry per thread, replaced when that thread starts a
 * new turn, and evicted beyond {@link MAX_TRACKED_THREADS} in
 * least-recently-opened order. A long-lived CLI session or an HTTP process
 * must not accumulate turns it will never read again.
 */
const ledgers = new Map<string, DelegationLedger>();

/** Maximum threads whose turn ledger is retained simultaneously. */
export const MAX_TRACKED_THREADS = 32;

/**
 * Opens — or returns — the ledger for a thread's current turn.
 *
 * The turn is identified by `turnKey` rather than by wall-clock time so the
 * same turn is recognized from any graph: the orchestration guard derives it
 * from the position of the route marker in persisted messages, which only
 * moves when a new user instruction starts.
 *
 * @param threadId - Conversation thread the turn belongs to.
 * @param turnKey - Stable identifier of the turn within that thread.
 * @param totalBudget - Tool attempts available for the whole turn.
 * @param split - Optional share of the pool offered to each role.
 * @returns The ledger for that turn, created on first call.
 */
export function openTurn(
  threadId: string,
  turnKey: string,
  totalBudget: number,
  split?: BudgetSplit,
): DelegationLedger {
  const existing = ledgers.get(threadId);
  if (existing?.turnKey === turnKey) return existing;

  const ledger: DelegationLedger = {
    threadId,
    turnKey,
    pool: new BudgetPool(totalBudget, split),
    mandates: new Map(),
    findings: [],
    questionsAsked: new Map(),
    delegationCounts: new Map(),
  };

  ledgers.set(threadId, ledger);
  evictOldestBeyondLimit();
  return ledger;
}

/**
 * Reads the ledger of a thread's current turn.
 *
 * Returns `undefined` when no turn is open, which is the normal case for every
 * agent mode that does not delegate. Callers must treat that as "no budget
 * accounting in force" and behave exactly as they did before this mechanism
 * existed — never as an error.
 *
 * @param threadId - Conversation thread to look up.
 * @returns The current ledger, or `undefined` when none is open.
 */
export function currentTurn(threadId: string | undefined): DelegationLedger | undefined {
  return threadId === undefined ? undefined : ledgers.get(threadId);
}

/**
 * Mints the identifier for the next delegation of a role in this turn.
 *
 * Identifiers are per-role ordinals — `coder#1`, `coder#2` — so a correction
 * cycle is distinguishable from the attempt it corrects, both in the budget
 * ledger and in telemetry.
 *
 * @param ledger - The turn's ledger.
 * @param role - Role about to be delegated to.
 * @returns The new delegation identifier.
 */
export function nextDelegationId(ledger: DelegationLedger, role: string): DelegationId {
  const ordinal = (ledger.delegationCounts.get(role) ?? 0) + 1;
  ledger.delegationCounts.set(role, ordinal);
  return `${role}#${ordinal}`;
}

/**
 * Records a finding so later delegates inherit it instead of rediscovering it.
 *
 * @param ledger - The turn's ledger.
 * @param finding - A verified observation worth carrying forward.
 */
export function recordFinding(ledger: DelegationLedger, finding: string): void {
  const trimmed = finding.trim();
  if (trimmed !== '' && !ledger.findings.includes(trimmed)) ledger.findings.push(trimmed);
}

/**
 * Discards every retained ledger.
 *
 * Exported for tests and for a process that resets its agent between runs.
 */
export function resetDelegationRegistry(): void {
  ledgers.clear();
}

function evictOldestBeyondLimit(): void {
  while (ledgers.size > MAX_TRACKED_THREADS) {
    const oldest = ledgers.keys().next();
    if (oldest.done) return;
    ledgers.delete(oldest.value);
  }
}
