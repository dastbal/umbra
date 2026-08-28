import { BudgetPool, DEFAULT_BUDGET_SPLIT } from './budget-pool';

describe('BudgetPool', () => {
  it('holds a reserve back so the turn can always close', () => {
    const pool = new BudgetPool(50);

    expect(pool.reserve).toBe(10);
    expect(pool.grantable).toBe(40);
  });

  it('grants each role its nominal share at the default pool size', () => {
    const pool = new BudgetPool(50);

    expect(pool.allocate('researcher#1', 'researcher')).toBe(14);
    expect(pool.allocate('coder#1', 'coder')).toBe(18);
    expect(pool.allocate('verifier#1', 'verifier')).toBe(8);
  });

  it('never grants the reserve, even when every role asks for its share', () => {
    const pool = new BudgetPool(50);
    pool.allocate('researcher#1', 'researcher');
    pool.allocate('coder#1', 'coder');
    pool.allocate('verifier#1', 'verifier');

    expect(pool.allocate('coder#2', 'coder')).toBe(0);
    expect(pool.grantable).toBe(0);
  });

  it('returns the same grant when a delegation is authorized twice', () => {
    const pool = new BudgetPool(50);
    const first = pool.allocate('researcher#1', 'researcher');

    expect(pool.allocate('researcher#1', 'researcher')).toBe(first);
    expect(pool.grantable).toBe(40 - first);
  });

  it('reports exhaustion once a delegation spends its grant', () => {
    const pool = new BudgetPool(50);
    pool.allocate('researcher#1', 'researcher');

    for (let attempt = 0; attempt < 14; attempt += 1) pool.consume('researcher#1');

    expect(pool.isExhausted('researcher#1')).toBe(true);
  });

  it('treats an unknown delegation as exhausted rather than unlimited', () => {
    expect(new BudgetPool(50).isExhausted('never-allocated')).toBe(true);
  });

  it('returns an unfinished grant to the pool so a correction stays affordable', () => {
    const pool = new BudgetPool(50);
    pool.allocate('researcher#1', 'researcher');
    pool.consume('researcher#1', 4);

    expect(pool.release('researcher#1')).toBe(10);
    expect(pool.grantable).toBe(36);
  });

  it('counts spend across every delegation of the turn', () => {
    const pool = new BudgetPool(50);
    pool.allocate('researcher#1', 'researcher');
    pool.allocate('coder#1', 'coder');
    pool.consume('researcher#1', 3);
    pool.consume('coder#1', 5);

    expect(pool.spent).toBe(8);
  });

  it('keeps a reserve of at least one attempt on a very small pool', () => {
    const pool = new BudgetPool(2);

    expect(pool.reserve).toBeGreaterThanOrEqual(1);
    expect(pool.grantable).toBeLessThan(2);
  });

  it('describes grants and spend without carrying prompts or arguments', () => {
    const pool = new BudgetPool(50);
    pool.allocate('coder#1', 'coder');
    pool.consume('coder#1', 2);

    const described = pool.describe();

    expect(described).toEqual({
      total: 50,
      reserve: 10,
      grantable: 22,
      allocations: [{ delegationId: 'coder#1', granted: 18, spent: 2 }],
    });
    expect(JSON.stringify(described)).not.toMatch(/prompt|content|args/i);
  });

  it('exposes a split whose shares and reserve account for the whole pool', () => {
    const { researcher, coder, verifier, reserve } = DEFAULT_BUDGET_SPLIT;

    expect(researcher + coder + verifier + reserve).toBeCloseTo(1, 5);
  });
});
