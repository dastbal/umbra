const mockVertexChatAdapter = jest.fn().mockImplementation((options: unknown) => ({
  getName: () => 'VertexChatAdapter',
  options,
}));

jest.mock('./vertex-chat-adapter', () => ({
  VertexChatAdapter: mockVertexChatAdapter,
}));

import { LLMProvider } from './provider';

/**
 * The Gemini half of the reasoning translation.
 *
 * Kept in its own file because it needs `VertexChatAdapter` mocked, while the
 * Claude specs need the real Anthropic classes mocked instead; one module
 * registry cannot serve both.
 */
describe('LLMProvider Gemini reasoning fields', () => {
  const originalCredentials = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const originalReasoning = process.env.AGENT_REASONING;
  const originalDisplay = process.env.AGENT_REASONING_DISPLAY;

  beforeEach(() => {
    mockVertexChatAdapter.mockClear();
    process.env.GOOGLE_APPLICATION_CREDENTIALS = __filename;
    delete process.env.AGENT_REASONING;
    delete process.env.AGENT_REASONING_DISPLAY;
  });

  afterAll(() => {
    restoreEnvironment('GOOGLE_APPLICATION_CREDENTIALS', originalCredentials);
    restoreEnvironment('AGENT_REASONING', originalReasoning);
    restoreEnvironment('AGENT_REASONING_DISPLAY', originalDisplay);
  });

  it('sends a named thinkingLevel on Gemini 3.x', () => {
    process.env.AGENT_REASONING = 'minimal';

    LLMProvider.createChatModel('gemini-3.5-flash');

    expect(mockVertexChatAdapter.mock.calls[0][0]).toMatchObject({
      model: 'gemini-3.5-flash',
      thinkingLevel: 'MINIMAL',
    });
    expect(mockVertexChatAdapter.mock.calls[0][0]).not.toHaveProperty('thinkingBudget');
  });

  it('sends a token budget on Gemini 2.5, which rejects thinkingLevel', () => {
    process.env.AGENT_REASONING = 'high';

    LLMProvider.createChatModel('gemini-2.5-pro');

    const options = mockVertexChatAdapter.mock.calls[0][0] as Record<string, unknown>;
    expect(options.thinkingBudget).toBe(16384);
    expect(options).not.toHaveProperty('thinkingLevel');
  });

  it('clamps a level Gemini 3.x does not offer instead of sending it', () => {
    // `max` is real on Claude Opus 5 and absent from Gemini's four steps.
    process.env.AGENT_REASONING = 'max';

    LLMProvider.createChatModel('gemini-3.5-flash');

    expect(mockVertexChatAdapter.mock.calls[0][0]).toMatchObject({ thinkingLevel: 'HIGH' });
  });

  it('never sends includeThoughts, which the library does not accept', () => {
    // `@langchain/google-common` derives the flag from the token budget
    // (`utils/gemini.js`:896); a passed value is silently dropped, so Umbra
    // does not pretend to send one.
    process.env.AGENT_REASONING = 'low';
    process.env.AGENT_REASONING_DISPLAY = 'true';

    LLMProvider.createChatModel('gemini-3.5-flash');
    expect(mockVertexChatAdapter.mock.calls[0][0]).not.toHaveProperty('includeThoughts');

    LLMProvider.createChatModel('gemini-2.5-pro');
    expect(mockVertexChatAdapter.mock.calls[1][0]).not.toHaveProperty('includeThoughts');
  });

  it('sends no reasoning fields when nothing is configured', () => {
    LLMProvider.createChatModel('gemini-3.5-flash');

    const options = mockVertexChatAdapter.mock.calls[0][0] as Record<string, unknown>;
    expect(options).not.toHaveProperty('thinkingLevel');
    expect(options).not.toHaveProperty('thinkingBudget');
    expect(options).not.toHaveProperty('includeThoughts');
  });
});

/** Restores one process environment variable to its pre-test value. */
function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
