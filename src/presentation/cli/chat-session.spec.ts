import { ChatSession } from './chat-session';

interface ChatSessionInternals {
  sendMessage(input: string): Promise<void>;
}

describe('ChatSession tool-cycle recovery', () => {
  it('resets only the active named session after a Vertex 400 follows a tool', async () => {
    const recoveredAgent = { streamEvents: jest.fn() };
    const sessionRecovery = jest.fn().mockResolvedValue(true);
    const agentFactory = jest.fn().mockResolvedValue(recoveredAgent);
    const showError = jest.fn();
    const renderer = {
      showThinking: jest.fn(),
      clearThinking: jest.fn(),
      streamToken: jest.fn(),
      showToolStart: jest.fn(),
      showToolEnd: jest.fn(),
      showError,
      finalizeTurn: jest.fn(),
      showTurnSeparator: jest.fn(),
    };
    const failingAgent = {
      async *streamEvents() {
        yield { event: 'on_tool_start', name: 'list_files', data: { input: {} } };
        throw new Error('Google request failed with status code 400');
      },
    };
    const session = new ChatSession(failingAgent, renderer as never, {
      mode: 'deep',
      model: 'gemini-3.5-flash',
      threadId: 'deep-test',
      sessionName: 'test',
      sessionRecovery,
      agentFactory,
    });

    await (session as unknown as ChatSessionInternals).sendMessage('hello');

    expect(sessionRecovery).toHaveBeenCalledTimes(1);
    expect(agentFactory).toHaveBeenCalledWith('gemini-3.5-flash');
    expect(showError).not.toHaveBeenCalled();
  });
});
