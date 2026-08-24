const mockRegisterHarnessProfile = jest.fn();

jest.mock('deepagents', () => ({
  createDeepAgent: jest.fn(),
  registerHarnessProfile: mockRegisterHarnessProfile,
}));

const mockCreateChatModel = jest.fn((model: string) => ({ model }));

jest.mock('../llm/provider', () => ({
  LLMProvider: {
    createChatModel: mockCreateChatModel,
  },
}));

import { DeepAgentFactory } from './deep-agent-factory';

interface DeepAgentFactoryInternals {
  registerGeminiHarnessProfile(model: string): void;
  resolveRuntimeModel(model: string): unknown;
  resolveRoleModel(model: string): unknown;
  buildSystemPrompt(
    rootDir: string,
    type: 'simple' | 'orchestrator' | 'analysis',
  ): string;
}

describe('DeepAgentFactory model routing', () => {
  const originalAgentModel = process.env.AGENT_MODEL;

  afterEach(() => {
    if (originalAgentModel === undefined) {
      delete process.env.AGENT_MODEL;
    } else {
      process.env.AGENT_MODEL = originalAgentModel;
    }
  });

  it('keeps the configured Coder model when the primary session uses Flash Lite', () => {
    process.env.AGENT_MODEL = 'gemini-2.5-flash-lite';
    const internals = DeepAgentFactory as unknown as DeepAgentFactoryInternals;

    expect(internals.resolveRoleModel('gemini-2.5-pro')).toEqual({
      model: 'gemini-2.5-pro',
    });
  });

  it('routes Gemini through the configured Vertex client instead of deepagents defaults', () => {
    const internals = DeepAgentFactory as unknown as DeepAgentFactoryInternals;

    expect(internals.resolveRuntimeModel('gemini-3.5-flash')).toEqual({
      model: 'gemini-3.5-flash',
    });
    expect(mockCreateChatModel).toHaveBeenCalledWith('gemini-3.5-flash');
  });

  it('registers the Gemini profile under deepagents Google provider key', () => {
    const internals = DeepAgentFactory as unknown as DeepAgentFactoryInternals;

    internals.registerGeminiHarnessProfile('gemini-3.5-flash');

    expect(mockRegisterHarnessProfile).toHaveBeenCalledWith(
      'google:gemini-3.5-flash',
      expect.objectContaining({
        excludedTools: expect.arrayContaining(['ls', 'grep', 'glob']),
      }),
    );
  });

  it('makes one-shot analysis override generic skill-discovery tool instructions', () => {
    const internals = DeepAgentFactory as unknown as DeepAgentFactoryInternals;
    const prompt = internals.buildSystemPrompt('C:\\project', 'analysis');

    expect(prompt).toContain('Do not call list_files');
    expect(prompt).toContain('Do not load a skill');
  });
});
