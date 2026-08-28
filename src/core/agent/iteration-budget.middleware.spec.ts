import {
  countCurrentTurnToolCalls,
  createIterationBudgetMiddleware,
  hasPriorEquivalentToolCall,
  shouldForceFinalResponse,
} from './iteration-budget.middleware';

describe('interactive iteration budget state', () => {
  it('counts tool calls only after the latest user instruction', () => {
    const messages = [
      { type: 'human', content: 'old request' },
      { tool_calls: [{ id: 'old', name: 'list_files', args: {} }] },
      { type: 'human', content: 'current request' },
      {
        tool_calls: [
          { id: 'one', name: 'ask_codebase', args: { query: 'ChatSession' } },
          { id: 'two', name: 'safe_read_file', args: { filePath: 'src/bin/cli.ts' } },
        ],
      },
    ];

    expect(countCurrentTurnToolCalls(messages)).toBe(2);
    expect(shouldForceFinalResponse(messages, 2)).toBe(true);
    expect(shouldForceFinalResponse(messages, 3)).toBe(false);
  });

  it('flags an equivalent prior tool call even when argument keys arrive in another order', () => {
    const messages = [
      { type: 'human', content: 'current request' },
      { tool_calls: [{ id: 'first', name: 'ask_codebase', args: { query: 'ChatSession', limit: 3 } }] },
    ];

    expect(hasPriorEquivalentToolCall(messages, {
      id: 'second',
      name: 'ask_codebase',
      args: { limit: 3, query: 'ChatSession' },
    })).toBe(true);
  });
});

describe('the ceiling is a ceiling, not a floor', () => {
  interface ToolHooks {
    beforeAgent: () => Promise<unknown>;
    wrapToolCall: (
      request: unknown,
      handler: (request: unknown) => Promise<unknown>,
    ) => Promise<{ content: string }>;
  }

  const callTool = async (
    hooks: ToolHooks,
    handler: jest.Mock,
    index: number,
  ): Promise<{ content: string }> => hooks.wrapToolCall(
    {
      toolCall: { id: `call-${index}`, name: 'safe_read_file', args: { path: `f${index}.ts` } },
      state: { messages: [{ type: 'human', content: 'go' }] },
    },
    handler,
  );

  // The defect this replaces: the budget was checked before a model call, so a
  // model that requested six tools in one response spent all six. Recorded
  // telemetry shows 13 of 120 turns exceeding it, the worst by 2.25x.
  it('refuses every call in a batch once the budget is spent', async () => {
    const handler = jest.fn().mockResolvedValue({ content: 'ok' });
    const hooks = createIterationBudgetMiddleware(3, process.cwd()) as unknown as ToolHooks;
    await hooks.beforeAgent();

    const results = [];
    for (let i = 0; i < 6; i += 1) results.push(await callTool(hooks, handler, i));

    expect(handler).toHaveBeenCalledTimes(3);
    expect(results.slice(3).every((r) => r.content.includes('TURN BUDGET REACHED'))).toBe(true);
    expect(results[3].content).toContain('3 of 3 tool calls');
  });

  it('starts each turn with a clean budget', async () => {
    const handler = jest.fn().mockResolvedValue({ content: 'ok' });
    const hooks = createIterationBudgetMiddleware(2, process.cwd()) as unknown as ToolHooks;

    await hooks.beforeAgent();
    await callTool(hooks, handler, 0);
    await callTool(hooks, handler, 1);
    await callTool(hooks, handler, 2);
    expect(handler).toHaveBeenCalledTimes(2);

    await hooks.beforeAgent();
    await callTool(hooks, handler, 3);
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it('stops a turn on wall clock even when almost no tools were used', async () => {
    const handler = jest.fn().mockResolvedValue({ content: 'ok' });
    let clock = 0;
    const hooks = createIterationBudgetMiddleware(8, process.cwd(), {
      limits: { maxSeconds: 300 },
      now: () => clock,
    }) as unknown as ToolHooks;

    await hooks.beforeAgent();
    await callTool(hooks, handler, 0);
    expect(handler).toHaveBeenCalledTimes(1);

    clock = 921_000;
    const refused = await callTool(hooks, handler, 1);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(refused.content).toContain('921s of 300s');
  });

  it('reports spend so the CLI can show what a turn is costing', async () => {
    const seen: Array<{ toolCalls: number }> = [];
    const handler = jest.fn().mockResolvedValue({ content: 'ok' });
    const hooks = createIterationBudgetMiddleware(8, process.cwd(), {
      onSpend: (spend) => { seen.push({ toolCalls: spend.toolCalls }); },
    }) as unknown as ToolHooks;

    await hooks.beforeAgent();
    await callTool(hooks, handler, 0);
    await callTool(hooks, handler, 1);

    expect(seen.map((s) => s.toolCalls)).toEqual([0, 1, 2]);
  });
});
