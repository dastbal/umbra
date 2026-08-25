import {
  countCurrentTurnToolCalls,
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
