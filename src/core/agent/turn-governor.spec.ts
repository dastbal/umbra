import {
  DEFAULT_TURN_LIMITS,
  type TurnLimits,
  createTurnSpend,
  describeStop,
  exceededDimension,
  readUsage,
  recordToolCall,
  recordUsage,
} from './turn-governor';

const limits = (overrides: Partial<TurnLimits> = {}): TurnLimits => ({
  ...DEFAULT_TURN_LIMITS,
  ...overrides,
});

describe('turn governor', () => {
  it('starts a turn with nothing spent', () => {
    const spend = createTurnSpend(1_000);
    expect(spend).toEqual({
      toolCalls: 0, inputTokens: 0, outputTokens: 0, startedAtMs: 1_000,
    });
    expect(exceededDimension(spend, limits(), 1_000)).toBeNull();
  });

  it('stops at the tool-call ceiling, and stops AT it rather than past it', () => {
    const spend = createTurnSpend(0);
    for (let i = 0; i < 7; i += 1) recordToolCall(spend);
    expect(exceededDimension(spend, limits({ maxToolCalls: 8 }), 0)).toBeNull();

    recordToolCall(spend);
    expect(exceededDimension(spend, limits({ maxToolCalls: 8 }), 0)).toBe('tool-calls');
  });

  it('bounds a turn by wall clock even when it spends almost no tools', () => {
    // The 921-second turn in recorded telemetry made one tool call.
    const spend = createTurnSpend(0);
    recordToolCall(spend);

    expect(exceededDimension(spend, limits({ maxSeconds: 300 }), 299_000)).toBeNull();
    expect(exceededDimension(spend, limits({ maxSeconds: 300 }), 300_000)).toBe('seconds');
    expect(exceededDimension(spend, limits({ maxSeconds: 300 }), 921_000)).toBe('seconds');
  });

  it('bounds a turn by tokens', () => {
    const spend = createTurnSpend(0);
    recordUsage(spend, { inputTokens: 120_000, outputTokens: 5_000 });
    expect(exceededDimension(spend, limits({ maxTokens: 250_000 }), 0)).toBeNull();

    recordUsage(spend, { inputTokens: 120_000, outputTokens: 5_000 });
    expect(exceededDimension(spend, limits({ maxTokens: 250_000 }), 0)).toBe('tokens');
  });

  it('accumulates usage across the model calls of one turn', () => {
    const spend = createTurnSpend(0);
    recordUsage(spend, { inputTokens: 10, outputTokens: 1 });
    recordUsage(spend, { inputTokens: 20, outputTokens: 2 });
    expect(spend).toEqual(expect.objectContaining({ inputTokens: 30, outputTokens: 3 }));
  });

  describe('the cost ceiling', () => {
    const costOf = () => 0.05;

    it('is enforced once a price and a cap both exist', () => {
      const spend = createTurnSpend(0);
      recordUsage(spend, { inputTokens: 1, outputTokens: 1 });
      expect(exceededDimension(spend, limits({ maxCostUsd: 0.02 }), 0, costOf)).toBe('cost');
      expect(exceededDimension(spend, limits({ maxCostUsd: 0.10 }), 0, costOf)).toBeNull();
    });

    it('stays inert when no cap is configured', () => {
      const spend = createTurnSpend(0);
      recordUsage(spend, { inputTokens: 1, outputTokens: 1 });
      expect(exceededDimension(spend, limits(), 0, costOf)).toBeNull();
    });

    // An unpriced model must disable the ceiling, never read as free. Treating
    // a missing price as zero is how cost tracking reported zero for the
    // starred default model in the first place.
    it('stays inert when the model has no published price', () => {
      const spend = createTurnSpend(0);
      recordUsage(spend, { inputTokens: 1_000, outputTokens: 1_000 });
      expect(
        exceededDimension(spend, limits({ maxCostUsd: 0.01 }), 0, () => undefined),
      ).toBeNull();
    });
  });

  describe('readUsage', () => {
    it('reads the provider field the deep path never consumed', () => {
      expect(readUsage({
        usage_metadata: { input_tokens: 51_000, output_tokens: 900, total_tokens: 51_900 },
      })).toEqual({ inputTokens: 51_000, outputTokens: 900 });
    });

    it.each([
      ['a response with no usage at all', {}],
      ['a null message', null],
      ['a zeroed report', { usage_metadata: { input_tokens: 0, output_tokens: 0 } }],
    ])('returns null for %s', (_label, message) => {
      expect(readUsage(message)).toBeNull();
    });

    it('tolerates a partial report rather than discarding it', () => {
      expect(readUsage({ usage_metadata: { output_tokens: 42 } }))
        .toEqual({ inputTokens: 0, outputTokens: 42 });
    });
  });

  it('names the ceiling that stopped the turn, so the model reports instead of apologising', () => {
    const spend = createTurnSpend(0);
    recordToolCall(spend);

    expect(describeStop('tool-calls', spend, limits({ maxToolCalls: 8 }), 0))
      .toContain('1 of 8 tool calls');
    expect(describeStop('seconds', spend, limits({ maxSeconds: 300 }), 480_000))
      .toContain('480s of 300s');
    expect(describeStop('tokens', spend, limits(), 0)).toContain('tokens');
    expect(describeStop('cost', spend, limits({ maxCostUsd: 0.02 }), 0)).toContain('0.02');
  });
});
