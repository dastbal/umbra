import {
  assertMandateComplete,
  IncompleteMandateError,
  mandateSchema,
  parseMandateOrder,
  renderMandate,
  type Mandate,
} from './mandate';

const completeMandate: Mandate = {
  userRequest: 'quiero que mejores los skills tuyos, revisalos y sugerime cambios',
  objective: 'Review every skill under skills/ and propose concrete improvements.',
  knownContext: ['The route is read-only; no file may be written this turn.'],
  inScope: ['The markdown files under skills/'],
  outOfScope: ['The general architecture of the project, which is settled.'],
  definitionOfDone: 'A research artifact listing each skill and its proposed change.',
  conventions: ['AGENTS.md: everything written into the repository is in English.'],
  budget: { toolCalls: 14, questions: 2 },
};

describe('assertMandateComplete', () => {
  it('accepts an order that carries the context the delegate cannot recover alone', () => {
    expect(() => assertMandateComplete(completeMandate)).not.toThrow();
  });

  it('refuses a delegation that drops the user request', () => {
    expect(() => assertMandateComplete({ ...completeMandate, userRequest: '   ' }))
      .toThrow(IncompleteMandateError);
  });

  it('names every missing field so the orchestrator can repair the order', () => {
    let thrown: IncompleteMandateError | undefined;
    try {
      assertMandateComplete({ ...completeMandate, objective: '', inScope: [] });
    } catch (error) {
      thrown = error as IncompleteMandateError;
    }

    expect(thrown?.missing).toEqual(expect.arrayContaining(['objective', 'inScope']));
  });

  it('explains that a subagent cannot read the conversation', () => {
    expect(() => assertMandateComplete({ ...completeMandate, knownContext: [] }))
      .toThrow(/cannot read the conversation/);
  });

  it('requires at least one thing the orchestrator already knows', () => {
    expect(() => assertMandateComplete({ ...completeMandate, knownContext: [] }))
      .toThrow(IncompleteMandateError);
  });

  it('accepts an absent out-of-scope list rather than inviting an invented boundary', () => {
    expect(() => assertMandateComplete({ ...completeMandate, outOfScope: [], conventions: [] }))
      .not.toThrow();
  });

  it('ignores the budget, which the pool grants and the model may not declare', () => {
    expect(() => assertMandateComplete({ ...completeMandate, budget: { toolCalls: 0, questions: 99 } }))
      .not.toThrow();
  });

  it('rejects a granted budget that allows no work at all', () => {
    const granted = mandateSchema.safeParse({ ...completeMandate, budget: { toolCalls: 0, questions: 2 } });

    expect(granted.success).toBe(false);
  });

  it('rejects a value that is not a mandate', () => {
    expect(() => assertMandateComplete(undefined)).toThrow(IncompleteMandateError);
  });
});

describe('renderMandate', () => {
  it('carries the verbatim request into the only message the subagent receives', () => {
    expect(renderMandate(completeMandate)).toContain(completeMandate.userRequest);
  });

  it('states the boundary that keeps exploration from sweeping the codebase', () => {
    const rendered = renderMandate(completeMandate);

    expect(rendered).toContain('Out of scope');
    expect(rendered).toContain('The general architecture of the project, which is settled.');
  });

  it('omits an empty section instead of rendering an empty heading', () => {
    const rendered = renderMandate({ ...completeMandate, outOfScope: [], conventions: [] });

    expect(rendered).not.toContain('Out of scope');
    expect(rendered).not.toContain('Constraints that must hold');
  });

  it('tells the delegate that exhausting the budget means returning a partial result', () => {
    const rendered = renderMandate(completeMandate);

    expect(rendered).toContain('14 tool attempts');
    expect(rendered).toContain('partial');
    expect(rendered).toContain('Never invent a finding');
  });
});

describe('parseMandateOrder', () => {
  const order = {
    userRequest: 'mejorá los skills',
    objective: 'Review the shipped guides',
    knownContext: ['The route is read-only'],
    inScope: ['skills/'],
    outOfScope: [],
    definitionOfDone: 'A research artifact',
    conventions: [],
  };

  it('reads an order out of a fenced json block', () => {
    const parsed = parseMandateOrder('Delegating now:\n```json\n' + JSON.stringify(order) + '\n```');

    expect(parsed).toEqual(order);
  });

  it('reads an order out of an unlabelled fence', () => {
    expect(parseMandateOrder('```\n' + JSON.stringify(order) + '\n```')).toEqual(order);
  });

  it('reads a bare object surrounded by prose', () => {
    expect(parseMandateOrder('Here it is ' + JSON.stringify(order) + ' — go.')).toEqual(order);
  });

  it('survives braces inside a string value', () => {
    const withBraces = { ...order, objective: 'Handle the {placeholder} case' };

    expect(parseMandateOrder(JSON.stringify(withBraces))).toEqual(withBraces);
  });

  it('returns nothing for the impoverished order that caused the sweep', () => {
    expect(parseMandateOrder('List all files in the skills/ directory')).toBeUndefined();
  });

  it('returns nothing for malformed json rather than a half-read order', () => {
    expect(parseMandateOrder('{ "userRequest": "unterminated')).toBeUndefined();
  });

  it('returns nothing when the description is not a string at all', () => {
    expect(parseMandateOrder(undefined)).toBeUndefined();
  });
});
