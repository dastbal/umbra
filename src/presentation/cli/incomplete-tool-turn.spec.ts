import { hasIncompleteToolTurn } from './incomplete-tool-turn';

describe('hasIncompleteToolTurn', () => {
  it('detects a checkpoint that ends with a tool result', () => {
    expect(hasIncompleteToolTurn([
      { getType: () => 'human' },
      { getType: () => 'ai' },
      { getType: () => 'tool' },
    ])).toBe(true);
  });

  it('keeps checkpoints that end with a completed assistant response', () => {
    expect(hasIncompleteToolTurn([
      { type: 'human' },
      { type: 'ai' },
    ])).toBe(false);
  });

  it('treats an empty checkpoint as resumable', () => {
    expect(hasIncompleteToolTurn([])).toBe(false);
  });
});
