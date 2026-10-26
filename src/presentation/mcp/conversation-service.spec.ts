import { McpConversationService } from './conversation-service';

describe('McpConversationService', () => {
  it('reuses an opaque receipt as the same LangGraph thread', async () => {
    const factory = jest.fn(async () => ({
      invoke: jest.fn(async () => ({ messages: [{ content: 'Remembered answer.' }] })),
    }));
    const service = new McpConversationService(factory);

    const first = await service.continue('C:\\project', 'First question');
    const next = await service.continue('C:\\project', 'And next?', first.conversationId);

    expect(next.conversationId).toBe(first.conversationId);
    expect(next.answer).toBe('Remembered answer.');
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith('C:\\project', `mcp-${first.conversationId}`);
  });

  it('rejects an arbitrary conversation identifier before it reaches a graph', async () => {
    const factory = jest.fn();
    const service = new McpConversationService(factory);

    await expect(service.continue('C:\\project', 'Hello', 'human-name')).rejects
      .toThrow('Umbra-issued UUID');
    expect(factory).not.toHaveBeenCalled();
  });
});
