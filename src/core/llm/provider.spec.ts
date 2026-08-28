const mockChatAnthropic = jest.fn().mockImplementation((options: unknown) => ({
  getName: () => 'ChatAnthropic',
  options,
}));
const mockAnthropicVertex = jest.fn().mockImplementation((options: unknown) => ({
  kind: 'AnthropicVertex',
  options,
}));

jest.mock('@langchain/anthropic', () => ({
  ChatAnthropic: mockChatAnthropic,
}));

jest.mock('@anthropic-ai/vertex-sdk', () => ({
  AnthropicVertex: mockAnthropicVertex,
}));

import { LLMProvider } from './provider';

describe('LLMProvider Claude on Vertex routing', () => {
  const originalProject = process.env.GOOGLE_CLOUD_PROJECT;
  const originalLocation = process.env.GOOGLE_CLOUD_LOCATION;
  const originalCredentials = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const originalReasoning = process.env.AGENT_REASONING;
  const originalReasoningDisplay = process.env.AGENT_REASONING_DISPLAY;

  beforeEach(() => {
    mockChatAnthropic.mockClear();
    mockAnthropicVertex.mockClear();
    process.env.GOOGLE_CLOUD_PROJECT = 'miblu';
    process.env.GOOGLE_CLOUD_LOCATION = 'global';
    process.env.GOOGLE_APPLICATION_CREDENTIALS = __filename;
    delete process.env.AGENT_REASONING;
    delete process.env.AGENT_REASONING_DISPLAY;
  });

  afterAll(() => {
    restoreEnvironment('GOOGLE_CLOUD_PROJECT', originalProject);
    restoreEnvironment('GOOGLE_CLOUD_LOCATION', originalLocation);
    restoreEnvironment('GOOGLE_APPLICATION_CREDENTIALS', originalCredentials);
    restoreEnvironment('AGENT_REASONING', originalReasoning);
    restoreEnvironment('AGENT_REASONING_DISPLAY', originalReasoningDisplay);
  });

  it('creates ChatAnthropic with an AnthropicVertex client and the bare model id', () => {
    const model = LLMProvider.createChatModel(
      'vertex-anthropic:claude-haiku-4-5@20251001',
    ) as unknown as { getName(): string };

    expect(model.getName()).toBe('ChatAnthropic');
    expect(mockAnthropicVertex).toHaveBeenCalledWith({
      projectId: 'miblu',
      region: 'global',
      maxRetries: 0,
    });
    expect(mockChatAnthropic).toHaveBeenCalledWith(expect.objectContaining({
      model: 'claude-haiku-4-5@20251001',
      temperature: 0,
      maxRetries: 0,
      createClient: expect.any(Function),
    }));

    const chatOptions = mockChatAnthropic.mock.calls[0][0] as {
      createClient(): unknown;
    };
    expect(chatOptions.createClient()).toBe(mockAnthropicVertex.mock.results[0].value);
  });

  it('omits temperature for the Claude 5 generation, which rejects it', () => {
    LLMProvider.createChatModel('vertex-anthropic:claude-sonnet-5');
    expect(mockChatAnthropic.mock.calls[0][0]).not.toHaveProperty('temperature');

    LLMProvider.createChatModel('vertex-anthropic:claude-opus-5');
    expect(mockChatAnthropic.mock.calls[1][0]).not.toHaveProperty('temperature');
  });

  it('sends the Claude 5 reasoning level as outputConfig.effort', () => {
    process.env.AGENT_REASONING = 'xhigh';

    LLMProvider.createChatModel('vertex-anthropic:claude-opus-5');

    expect(mockChatAnthropic.mock.calls[0][0]).toMatchObject({
      outputConfig: { effort: 'xhigh' },
    });
    // Depth without visibility: nothing is shown unless display was asked for.
    expect(mockChatAnthropic.mock.calls[0][0]).not.toHaveProperty('thinking');
  });

  it('sends the Claude 4.5 reasoning level as a thinking token budget', () => {
    process.env.AGENT_REASONING = 'medium';

    LLMProvider.createChatModel('vertex-anthropic:claude-haiku-4-5@20251001');

    const options = mockChatAnthropic.mock.calls[0][0] as {
      thinking?: { type: string; budget_tokens?: number };
      outputConfig?: unknown;
    };
    expect(options.thinking).toEqual({ type: 'enabled', budget_tokens: 4096 });
    // Haiku 4.5 rejects outputConfig.effort outright, so it must never appear.
    expect(options.outputConfig).toBeUndefined();
  });

  it('drops temperature on Claude 4.5 once thinking is enabled', () => {
    // Haiku 4.5 accepts temperature, and accepts thinking, but rejects the
    // pair: "temperature is not supported when thinking is enabled".
    process.env.AGENT_REASONING = 'low';

    LLMProvider.createChatModel('vertex-anthropic:claude-haiku-4-5@20251001');
    expect(mockChatAnthropic.mock.calls[0][0]).not.toHaveProperty('temperature');

    // With no reasoning level there is no thinking block, so the deterministic
    // sampling Claude 4.5 still honors is kept.
    delete process.env.AGENT_REASONING;
    LLMProvider.createChatModel('vertex-anthropic:claude-haiku-4-5@20251001');
    expect(mockChatAnthropic.mock.calls[1][0]).toMatchObject({ temperature: 0 });
  });

  it('clamps a level the selected Claude model does not offer', () => {
    // `minimal` is real on Gemini 3.x and rejected by every Claude model.
    process.env.AGENT_REASONING = 'minimal';

    LLMProvider.createChatModel('vertex-anthropic:claude-sonnet-5');

    expect(mockChatAnthropic.mock.calls[0][0]).toMatchObject({
      outputConfig: { effort: 'low' },
    });
  });

  it('asks for summarized reasoning only where display is controllable', () => {
    process.env.AGENT_REASONING = 'high';
    process.env.AGENT_REASONING_DISPLAY = 'true';

    // Claude 5 is the one family whose display Umbra controls.
    LLMProvider.createChatModel('vertex-anthropic:claude-opus-5');
    expect(mockChatAnthropic.mock.calls[0][0]).toMatchObject({
      thinking: { type: 'adaptive', display: 'summarized' },
    });

    // Claude 4.5 returns its thinking text whenever thinking is on, so the
    // parameter would claim a control that does not exist.
    LLMProvider.createChatModel('vertex-anthropic:claude-haiku-4-5@20251001');
    const haiku = mockChatAnthropic.mock.calls[1][0] as {
      thinking?: Record<string, unknown>;
    };
    expect(haiku.thinking).toEqual({ type: 'enabled', budget_tokens: 16384 });
  });

  it('omits the display request when the operator did not ask for it', () => {
    process.env.AGENT_REASONING = 'high';

    LLMProvider.createChatModel('vertex-anthropic:claude-opus-5');

    expect(mockChatAnthropic.mock.calls[0][0]).not.toHaveProperty('thinking');
  });

  it('sends no reasoning fields when nothing is configured', () => {
    const options = (() => {
      LLMProvider.createChatModel('vertex-anthropic:claude-opus-5');
      return mockChatAnthropic.mock.calls[0][0] as Record<string, unknown>;
    })();

    expect(options).not.toHaveProperty('outputConfig');
    expect(options).not.toHaveProperty('thinking');
  });

  it('fails before creating a client when the GCP project is missing', () => {
    delete process.env.GOOGLE_CLOUD_PROJECT;

    expect(() => LLMProvider.createChatModel(
      'vertex-anthropic:claude-sonnet-5',
    )).toThrow('GOOGLE_CLOUD_PROJECT');
    expect(mockAnthropicVertex).not.toHaveBeenCalled();
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
