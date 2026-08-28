import {
  currentTurn,
  MAX_TRACKED_THREADS,
  nextDelegationId,
  openTurn,
  recordFinding,
  resetDelegationRegistry,
} from './delegation-registry';

describe('the turn ledger', () => {
  beforeEach(() => resetDelegationRegistry());

  it('gives the orchestrator and its delegates the same pool', () => {
    const opened = openTurn('thread-a', 'turn-1', 50);

    expect(currentTurn('thread-a')).toBe(opened);
    expect(opened.pool.total).toBe(50);
  });

  it('returns the same ledger when the same turn is opened again', () => {
    const first = openTurn('thread-a', 'turn-1', 50);
    first.pool.allocate('researcher#1', 'researcher');

    const second = openTurn('thread-a', 'turn-1', 50);

    expect(second).toBe(first);
    expect(second.pool.spent).toBe(0);
    expect(second.pool.grantable).toBe(26);
  });

  it('starts a fresh budget when the thread begins a new turn', () => {
    openTurn('thread-a', 'turn-1', 50).pool.allocate('researcher#1', 'researcher');

    const next = openTurn('thread-a', 'turn-2', 50);

    expect(next.pool.grantable).toBe(40);
    expect(next.mandates.size).toBe(0);
  });

  it('keeps threads independent of one another', () => {
    openTurn('thread-a', 'turn-1', 50).pool.allocate('coder#1', 'coder');
    openTurn('thread-b', 'turn-1', 50);

    expect(currentTurn('thread-b')?.pool.grantable).toBe(40);
    expect(currentTurn('thread-a')?.pool.grantable).toBe(22);
  });

  it('reports no ledger for a mode that never delegates', () => {
    expect(currentTurn('thread-never-opened')).toBeUndefined();
    expect(currentTurn(undefined)).toBeUndefined();
  });

  it('numbers delegations per role so a correction is distinguishable', () => {
    const ledger = openTurn('thread-a', 'turn-1', 50);

    expect(nextDelegationId(ledger, 'coder')).toBe('coder#1');
    expect(nextDelegationId(ledger, 'coder')).toBe('coder#2');
    expect(nextDelegationId(ledger, 'researcher')).toBe('researcher#1');
  });

  it('carries findings forward without repeating them', () => {
    const ledger = openTurn('thread-a', 'turn-1', 50);

    recordFinding(ledger, 'skills/ holds six markdown guides');
    recordFinding(ledger, 'skills/ holds six markdown guides');
    recordFinding(ledger, '   ');

    expect(ledger.findings).toEqual(['skills/ holds six markdown guides']);
  });

  it('evicts the oldest thread instead of growing without bound', () => {
    for (let index = 0; index <= MAX_TRACKED_THREADS; index += 1) {
      openTurn(`thread-${index}`, 'turn-1', 50);
    }

    expect(currentTurn('thread-0')).toBeUndefined();
    expect(currentTurn(`thread-${MAX_TRACKED_THREADS}`)).toBeDefined();
  });
});
