import {
  rejectsTemperature,
  isVertexAnthropicModel,
  isGoogleCloudProjectId,
  resolveConfiguredModel,
  resolveModelForSession,
  resolveVertexLocation,
  resolveVertexProject,
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

  it('expands the curated Claude-on-Vertex aliases', () => {
    expect(resolveConfiguredModel('claude-fast'))
      .toBe('vertex-anthropic:claude-haiku-4-5@20251001');
    expect(resolveConfiguredModel('claude'))
      .toBe('vertex-anthropic:claude-sonnet-5');
    expect(resolveConfiguredModel('claude-max'))
      .toBe('vertex-anthropic:claude-opus-5');
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

  it('recognizes Claude models whose transport is Vertex AI', () => {
    expect(isVertexAnthropicModel('vertex-anthropic:claude-haiku-4-5@20251001')).toBe(true);
    expect(isVertexAnthropicModel('vertex-anthropic:claude-sonnet-5')).toBe(true);
    expect(isVertexAnthropicModel('anthropic:claude-sonnet-5')).toBe(false);
    expect(isVertexAnthropicModel('gemini-3.5-flash')).toBe(false);
  });

  it('flags only the Claude 5 generation as rejecting temperature', () => {
    expect(rejectsTemperature('vertex-anthropic:claude-sonnet-5')).toBe(true);
    expect(rejectsTemperature('vertex-anthropic:claude-opus-5')).toBe(true);
    expect(rejectsTemperature('claude-opus-5@20260401')).toBe(true);
    expect(rejectsTemperature('vertex-anthropic:claude-haiku-4-5@20251001')).toBe(false);
    expect(rejectsTemperature('gemini-3.5-flash')).toBe(false);
  });

  it('trims an explicitly configured Vertex project', () => {
    expect(resolveVertexProject('  miblu  ')).toBe('miblu');
    expect(resolveVertexProject('   ')).toBeUndefined();
  });

  it('accepts project ids but rejects display names and shell metacharacters', () => {
    expect(isGoogleCloudProjectId('blue-label')).toBe(true);
    expect(isGoogleCloudProjectId('project-123456')).toBe(true);
    expect(isGoogleCloudProjectId('MIBLU')).toBe(false);
    expect(isGoogleCloudProjectId('blue-label & calc')).toBe(false);
  });
});
