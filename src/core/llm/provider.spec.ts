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

  beforeEach(() => {
    mockChatAnthropic.mockClear();
    mockAnthropicVertex.mockClear();
    process.env.GOOGLE_CLOUD_PROJECT = 'miblu';
    process.env.GOOGLE_CLOUD_LOCATION = 'global';
    process.env.GOOGLE_APPLICATION_CREDENTIALS = __filename;
  });

  afterAll(() => {
    restoreEnvironment('GOOGLE_CLOUD_PROJECT', originalProject);
    restoreEnvironment('GOOGLE_CLOUD_LOCATION', originalLocation);
    restoreEnvironment('GOOGLE_APPLICATION_CREDENTIALS', originalCredentials);
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
