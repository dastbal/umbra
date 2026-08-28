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

// The two readers the ADC fallback uses are replaced wholesale rather than
// spied on: `fs`'s own properties are not configurable, so `jest.spyOn` throws
// "Cannot redefine property". Everything else in `fs` stays real.
jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: jest.fn(actual.existsSync),
    readFileSync: jest.fn(actual.readFileSync),
  };
});

import * as fs from 'fs';
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
    // Default: no ADC file, so tests that do not stub it see only the env var.
    stubAdcFile(null);
  });

  afterEach(() => {
    jest.clearAllMocks();
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

  it('falls back to the project the ADC login stored, with no env var set', () => {
    // `umbra auth login --project X` writes `quota_project_id` into the ADC
    // file, and Google's own detection ignores that field — an authorized_user
    // file has no `project_id`. Reading it is what makes a consumer project
    // work without adding Google settings to its .env.
    delete process.env.GOOGLE_CLOUD_PROJECT;
    stubAdcFile({ quota_project_id: 'from-adc-login' });

    LLMProvider.createChatModel('vertex-anthropic:claude-sonnet-5');

    expect(mockAnthropicVertex).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'from-adc-login' }),
    );
  });

  it('publishes the ADC project into the environment Google clients read', () => {
    // `GOOGLE_CLOUD_PROJECT` is the only lever that reaches every Google
    // client, including the ones Umbra does not construct. Passing the project
    // per client was not enough: `@langchain/google-vertexai` has no `project`
    // option, and the raw "Unable to detect a Project Id" survived until this
    // variable was set. Found by a live run, not by a unit test.
    delete process.env.GOOGLE_CLOUD_PROJECT;
    stubAdcFile({ quota_project_id: 'from-adc-login' });

    LLMProvider.createChatModel('vertex-anthropic:claude-sonnet-5');

    expect(process.env.GOOGLE_CLOUD_PROJECT).toBe('from-adc-login');
  });

  it('never overwrites a project the operator configured', () => {
    process.env.GOOGLE_CLOUD_PROJECT = 'from-env';
    stubAdcFile({ quota_project_id: 'from-adc-login' });

    LLMProvider.createChatModel('vertex-anthropic:claude-sonnet-5');

    expect(process.env.GOOGLE_CLOUD_PROJECT).toBe('from-env');
  });

  it('prefers an explicit project over the ADC fallback', () => {
    process.env.GOOGLE_CLOUD_PROJECT = 'from-env';
    stubAdcFile({ quota_project_id: 'from-adc-login' });

    LLMProvider.createChatModel('vertex-anthropic:claude-sonnet-5');

    expect(mockAnthropicVertex).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'from-env' }),
    );
  });

  it('fails before creating a client when no source declares a project', () => {
    delete process.env.GOOGLE_CLOUD_PROJECT;
    stubAdcFile(null);

    expect(() => LLMProvider.createChatModel(
      'vertex-anthropic:claude-sonnet-5',
    )).toThrow('GOOGLE_CLOUD_PROJECT');
    expect(mockAnthropicVertex).not.toHaveBeenCalled();
  });
});

/**
 * Controls what the provider sees when it looks for the local ADC file.
 *
 * The real file on the developer's machine holds a real project, which would
 * make these expectations depend on whose machine runs them. Only the ADC path
 * is intercepted: the credentials-present check must keep seeing this spec file,
 * which is what `GOOGLE_APPLICATION_CREDENTIALS` points at.
 *
 * @param contents - Parsed ADC contents to serve, or null for "no file".
 */
function stubAdcFile(contents: Record<string, unknown> | null): void {
  const isAdcPath = (target: unknown): boolean =>
    String(target).includes('application_default_credentials.json');

  (fs.existsSync as jest.Mock).mockImplementation((target: unknown) =>
    isAdcPath(target) ? contents !== null : true,
  );
  (fs.readFileSync as jest.Mock).mockImplementation((target: unknown) =>
    isAdcPath(target) ? JSON.stringify(contents ?? {}) : '',
  );
}

/** Restores one process environment variable to its pre-test value. */
function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
