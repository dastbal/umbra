import {
  resolveConfiguredModel,
  resolveModelForSession,
  resolveVertexLocation,
} from './model-resolver';

describe('model resolution', () => {
  const originalAgentModel = process.env.AGENT_MODEL;

  afterEach(() => {
    if (originalAgentModel === undefined) {
      delete process.env.AGENT_MODEL;
    } else {
      process.env.AGENT_MODEL = originalAgentModel;
    }
  });

  it('expands a configured tier without reading the global environment override', () => {
    process.env.AGENT_MODEL = 'gemini-2.5-flash-lite';

    expect(resolveConfiguredModel('pro')).toBe('gemini-2.5-pro');
    expect(resolveConfiguredModel('gemini-2.5-pro')).toBe('gemini-2.5-pro');
  });

  it('uses AGENT_MODEL for the primary session when no explicit CLI override exists', () => {
    process.env.AGENT_MODEL = 'gemini-2.5-flash-lite';

    expect(resolveModelForSession('gemini-2.5-pro')).toBe('gemini-2.5-flash-lite');
  });

  it('lets an explicit model override win for a quality-sensitive session', () => {
    process.env.AGENT_MODEL = 'gemini-2.5-flash-lite';

    expect(resolveModelForSession('gemini-2.5-flash-lite', 'gemini-2.5-pro'))
      .toBe('gemini-2.5-pro');
  });

  it('uses the global Vertex endpoint unless an explicit region is configured', () => {
    expect(resolveVertexLocation()).toBe('global');
    expect(resolveVertexLocation('europe-west2')).toBe('europe-west2');
    expect(resolveVertexLocation('  ')).toBe('global');
  });
});
