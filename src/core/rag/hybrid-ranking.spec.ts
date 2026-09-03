import { fuseRankings, hasGroundedEvidence } from './hybrid-ranking';

describe('hybrid retrieval ranking', () => {
  it('fuses rank positions without comparing lexical and semantic scores', () => {
    const candidates = fuseRankings(
      [
        { id: 'semantic-only', lexicalExact: false },
        { id: 'both', lexicalExact: false },
      ],
      [
        { id: 'both', lexicalExact: false },
        { id: 'lexical-only', lexicalExact: true },
      ],
      4,
    );

    expect(candidates.map((candidate) => candidate.id)).toEqual([
      'both',
      'semantic-only',
      'lexical-only',
    ]);
    expect(candidates[0]).toMatchObject({ evidence: 'hybrid' });
    expect(candidates[2]).toMatchObject({ evidence: 'lexical', lexicalExact: true });
  });

  it('abstains when semantic neighbours have no independent support', () => {
    const candidates = fuseRankings(
      [{ id: 'nearest', lexicalExact: false }],
      [],
      4,
    );

    expect(hasGroundedEvidence(candidates)).toBe(false);
  });

  it('accepts either hybrid agreement or direct lexical evidence', () => {
    expect(
      hasGroundedEvidence(
        fuseRankings([{ id: 'same', lexicalExact: false }], [{ id: 'same', lexicalExact: false }], 4),
      ),
    ).toBe(true);
    expect(
      hasGroundedEvidence(
        fuseRankings([], [{ id: 'path-match', lexicalExact: true }], 4),
      ),
    ).toBe(true);
  });
});
