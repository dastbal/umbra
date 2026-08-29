import {
  LanePromotionError,
  laneAllowsTools,
  laneAllowsWrites,
  promoteLane,
  readLane,
  triage,
} from './route-lane';

describe('triage', () => {
  it('sorts a message that asks for nothing where nothing can happen', () => {
    // Observed 2026-08-28: "maestro" matched no pattern, fell through to the
    // implementation default, and a greeting cost 27 calls, 677.8k tokens,
    // $0.0729 and a file written to disk.
    expect(triage('maestro')).toBe('answer');
    expect(triage('hola')).toBe('answer');
    expect(triage('gracias')).toBe('answer');
  });

  it('sorts an unrecognised message down, never up', () => {
    // The property that makes the word lists stop mattering: a gap costs one
    // promotion, not a wrong route for the whole turn.
    expect(triage('el login esta roto')).toBe('read');
    expect(triage('src/app.ts')).toBe('read');
    expect(triage('esa cosa del guard de ayer')).toBe('read');
  });

  it('takes the fast path when the request plainly asks for a change', () => {
    for (const request of ['crear un modulo', 'agregar un endpoint', 'refactor the guard']) {
      expect(triage(request)).toBe('change');
    }
  });

  it('treats an affirmation as permission to carry on', () => {
    // ADR-020: "dale" means proceed with what was proposed. Sorting it down
    // would refuse work the operator just approved.
    for (const affirmation of ['dale', 'ok', 'listo', 'seguí', 'adelante']) {
      expect(triage(affirmation)).toBe('change');
    }
  });

  it('answers a question by reading rather than by writing', () => {
    expect(triage('¿cómo funciona el guard?')).toBe('read');
    expect(triage('maestro?')).toBe('read');
  });
});

describe('promoteLane', () => {
  it('raises a turn that discovered it must write', () => {
    const promotion = promoteLane('read', 'change', 'The fix requires editing the guard.', false);

    expect(promotion).toEqual({
      lane: 'change',
      raised: true,
      reason: 'The fix requires editing the guard.',
    });
  });

  it('refuses to raise a message that asked for nothing', () => {
    // The rule that keeps a greeting from reaching the disk: nothing in it ever
    // asked, so there is nothing to escalate.
    expect(() => promoteLane('answer', 'change', 'I would like to write a test', false))
      .toThrow(LanePromotionError);
  });

  it('refuses a promotion with nothing to say', () => {
    expect(() => promoteLane('read', 'change', '   ', false)).toThrow(/needs a reason/);
  });

  it('allows one promotion per turn, so a model cannot walk itself up', () => {
    expect(() => promoteLane('read', 'change', 'and now I need more', true))
      .toThrow(/already been escalated/);
  });

  it('treats a request for the lane it already has as a no-op, not an error', () => {
    const promotion = promoteLane('change', 'read', 'just checking', false);

    expect(promotion.raised).toBe(false);
    expect(promotion.lane).toBe('change');
  });

  it('never moves a turn downward through a promotion', () => {
    expect(promoteLane('change', 'answer', 'quieter now', false).lane).toBe('change');
  });
});

describe('what a lane permits', () => {
  it('lets only the change lane write', () => {
    expect(laneAllowsWrites('change')).toBe(true);
    expect(laneAllowsWrites('read')).toBe(false);
    expect(laneAllowsWrites('answer')).toBe(false);
  });

  it('lets every lane but answer use a tool', () => {
    expect(laneAllowsTools('answer')).toBe(false);
    expect(laneAllowsTools('read')).toBe(true);
    expect(laneAllowsTools('change')).toBe(true);
  });
});

describe('readLane', () => {
  it('reads the lane an envelope declares', () => {
    expect(readLane('[ORCHESTRATION_ROUTE trusted=true complexity=small lane=answer]')).toBe('answer');
    expect(readLane('[ORCHESTRATION_ROUTE trusted=true complexity=medium lane=change]')).toBe('change');
  });

  it('reads an envelope written before lanes existed', () => {
    // A checkpoint recorded by an earlier version must not be read as a lane it
    // never chose.
    expect(readLane('[ORCHESTRATION_ROUTE trusted=true implementation=false]')).toBe('read');
    expect(readLane('[ORCHESTRATION_ROUTE trusted=true implementation=true]')).toBe('change');
  });
});
