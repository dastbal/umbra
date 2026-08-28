import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ChatSession } from './chat-session';

interface ChatSessionInternals {
  sendMessage(input: string): Promise<void>;
  handledAsSmallTalk(input: string): boolean;
}

describe('ChatSession tool-cycle recovery', () => {
  it('resets only the active named session after a Vertex 400 follows a tool', async () => {
    const auditRootDir = mkdtempSync(join(tmpdir(), 'nestjs-agent-chat-session-'));
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
    try {
      const session = new ChatSession(failingAgent, renderer as never, {
        mode: 'deep',
        model: 'gemini-3.5-flash',
        threadId: 'deep-test',
        sessionName: 'test',
        sessionRecovery,
        agentFactory,
        auditRootDir,
      });

      await (session as unknown as ChatSessionInternals).sendMessage('hello');

      expect(sessionRecovery).toHaveBeenCalledTimes(1);
      expect(agentFactory).toHaveBeenCalledWith('gemini-3.5-flash');
      expect(showError).not.toHaveBeenCalled();
    } finally {
      rmSync(auditRootDir, { recursive: true, force: true });
    }
  });
});

describe('ChatSession conversation gate', () => {
  let auditRootDir: string;
  let logSpy: jest.SpyInstance;

  const buildSession = (agent: { streamEvents: jest.Mock }) => new ChatSession(
    agent as never,
    {
      showThinking: jest.fn(),
      clearThinking: jest.fn(),
      streamToken: jest.fn(),
      showToolStart: jest.fn(),
      showToolEnd: jest.fn(),
      showError: jest.fn(),
      finalizeTurn: jest.fn(),
      showTurnSeparator: jest.fn(),
    } as never,
    {
      mode: 'deep',
      model: 'gemini-3.5-flash',
      threadId: 'deep-gate-test',
      auditRootDir,
    },
  );

  beforeEach(() => {
    auditRootDir = mkdtempSync(join(tmpdir(), 'nestjs-agent-gate-'));
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    rmSync(auditRootDir, { recursive: true, force: true });
  });

  it.each(['hey', 'hola', 'gracias', 'chau'])(
    'answers %j without ever reaching the agent',
    (input) => {
      const agent = { streamEvents: jest.fn() };
      const session = buildSession(agent) as unknown as ChatSessionInternals;

      expect(session.handledAsSmallTalk(input)).toBe(true);
      // The whole point: audit `84ad7c97` recorded 11 tool calls and 108
      // seconds for "hey". A handled greeting must cost zero model calls.
      expect(agent.streamEvents).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalled();
    },
  );

  it.each([
    'explain the RAG module',
    'hola, agrega un endpoint de usuarios',
    'dale',
    'segui',
  ])('lets %j through to the agent', (input) => {
    const agent = { streamEvents: jest.fn() };
    const session = buildSession(agent) as unknown as ChatSessionInternals;

    expect(session.handledAsSmallTalk(input)).toBe(false);
  });
});
