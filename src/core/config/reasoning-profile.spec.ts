import {
  describeReasoning,
  isReasoningLevel,
  reasoningBudgetTokens,
  resolveConfiguredReasoningDisplay,
  resolveConfiguredReasoningLevel,
  resolveReasoningLevel,
} from './reasoning-profile';

describe('describeReasoning', () => {
  // Each expectation below mirrors a response observed against the project's
  // live Vertex endpoint on 2026-08-28. See ADR-016 for the raw results.

  it('routes the Claude 5 generation to named effort levels', () => {
    for (const model of [
      'vertex-anthropic:claude-sonnet-5',
      'vertex-anthropic:claude-opus-5',
      'vertex-anthropic:claude-opus-5@20260401',
    ]) {
      expect(describeReasoning(model)).toEqual({
        mechanism: 'effort',
        levels: ['low', 'medium', 'high', 'xhigh', 'max'],
        display: 'controllable',
      });
    }
  });

  it('routes Claude 4.5 to a token budget, not to effort', () => {
    // Haiku 4.5 rejects output_config.effort with "Extra inputs are not
    // permitted" — it behaves like Gemini 2.5, not like its Claude siblings.
    expect(describeReasoning('vertex-anthropic:claude-haiku-4-5@20251001')).toEqual({
      mechanism: 'thinking-budget',
      levels: ['low', 'medium', 'high'],
      display: 'forced-on',
    });
  });

  it('routes Gemini 3.x to named thinking levels', () => {
    for (const model of ['gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']) {
      expect(describeReasoning(model)).toEqual({
        mechanism: 'thinking-level',
        levels: ['minimal', 'low', 'medium', 'high'],
        display: 'unavailable',
      });
    }
  });

  it('routes Gemini 2.5 to a token budget, which is all it accepts', () => {
    for (const model of ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro']) {
      expect(describeReasoning(model)).toEqual({
        mechanism: 'thinking-budget',
        levels: ['low', 'medium', 'high'],
        display: 'forced-on',
      });
    }
  });

  it('reports no reasoning controls for Ollama and for unknown models', () => {
    const none = { mechanism: 'none', levels: [], display: 'unavailable' };
    expect(describeReasoning('ollama:gemma4')).toEqual(none);
    expect(describeReasoning('some-future-model')).toEqual(none);
  });
});

describe('resolveReasoningLevel', () => {
  it('passes through a level the model supports', () => {
    expect(resolveReasoningLevel('vertex-anthropic:claude-opus-5', 'xhigh')).toBe('xhigh');
    expect(resolveReasoningLevel('gemini-3.5-flash', 'minimal')).toBe('minimal');
  });

  it('clamps downward so a carried-over level never escalates cost', () => {
    // `max` and `xhigh` exist on Claude 5 and not on Gemini 3.x.
    expect(resolveReasoningLevel('gemini-3.5-flash', 'max')).toBe('high');
    expect(resolveReasoningLevel('gemini-3.5-flash', 'xhigh')).toBe('high');
    // `minimal` exists on Gemini 3.x and not on the budget-based models.
    expect(resolveReasoningLevel('gemini-2.5-pro', 'minimal')).toBe('low');
  });

  it('omits the parameter when nothing is configured or nothing is supported', () => {
    expect(resolveReasoningLevel('gemini-3.5-flash', undefined)).toBeUndefined();
    expect(resolveReasoningLevel('ollama:gemma4', 'high')).toBeUndefined();
  });
});

describe('reasoningBudgetTokens', () => {
  it('never returns a budget below Anthropic 1024-token floor', () => {
    for (const level of ['low', 'medium', 'high'] as const) {
      expect(reasoningBudgetTokens(level)).toBeGreaterThanOrEqual(1024);
    }
  });

  it('has no budget for the levels that cannot be expressed as one', () => {
    expect(reasoningBudgetTokens('minimal')).toBeUndefined();
    expect(reasoningBudgetTokens('xhigh')).toBeUndefined();
    expect(reasoningBudgetTokens('max')).toBeUndefined();
  });
});

describe('environment resolution', () => {
  const originalLevel = process.env.AGENT_REASONING;
  const originalDisplay = process.env.AGENT_REASONING_DISPLAY;

  afterEach(() => {
    if (originalLevel === undefined) delete process.env.AGENT_REASONING;
    else process.env.AGENT_REASONING = originalLevel;
    if (originalDisplay === undefined) delete process.env.AGENT_REASONING_DISPLAY;
    else process.env.AGENT_REASONING_DISPLAY = originalDisplay;
  });

  it('reads a configured level and ignores an unrecognized one', () => {
    expect(resolveConfiguredReasoningLevel('  HIGH ')).toBe('high');
    // A typo leaves the provider default in place rather than failing to start.
    expect(resolveConfiguredReasoningLevel('hihg')).toBeUndefined();
    expect(resolveConfiguredReasoningLevel('')).toBeUndefined();
  });

  it('falls back to the environment when no override is given', () => {
    process.env.AGENT_REASONING = 'medium';
    expect(resolveConfiguredReasoningLevel()).toBe('medium');
    delete process.env.AGENT_REASONING;
    expect(resolveConfiguredReasoningLevel()).toBeUndefined();
  });

  it('treats display as opt-in', () => {
    expect(resolveConfiguredReasoningDisplay('true')).toBe(true);
    expect(resolveConfiguredReasoningDisplay('on')).toBe(true);
    expect(resolveConfiguredReasoningDisplay('1')).toBe(true);
    expect(resolveConfiguredReasoningDisplay('false')).toBe(false);
    expect(resolveConfiguredReasoningDisplay('')).toBe(false);
  });
});

describe('isReasoningLevel', () => {
  it('narrows only Umbra own levels', () => {
    expect(isReasoningLevel('max')).toBe(true);
    expect(isReasoningLevel('MAX')).toBe(false);
    expect(isReasoningLevel('extreme')).toBe(false);
  });
});
