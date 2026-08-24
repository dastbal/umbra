import {
  evidenceCitationSchema,
  groundedAnalysisSchema,
  buildEvidenceProtocolPrompt,
} from './evidence-protocol';

describe('evidence protocol', () => {
  it('requires a concrete project path for every citation', () => {
    expect(
      evidenceCitationSchema.safeParse({
        path: 'src/core/agent/deep-agent-factory.ts',
        line: 150,
        claim: 'DeepAgentFactory creates the active deep agent',
        kind: 'direct',
      }).success,
    ).toBe(true);

    expect(
      evidenceCitationSchema.safeParse({
        claim: 'This sounds like a factory',
        kind: 'inference',
      }).success,
    ).toBe(false);
  });

  it('rejects a finding without evidence or with an unsupported confidence', () => {
    expect(
      groundedAnalysisSchema.safeParse({
        summary: 'The project is a NestJS agent library.',
        findings: [
          {
            claim: 'DeepAgentFactory is active',
            confidence: 'high',
            evidence: [
              {
                path: 'src/core/agent/deep-agent-factory.ts',
                claim: 'The active factory is exported and used by the CLI',
                kind: 'direct',
              },
            ],
          },
        ],
        unknowns: [],
        filesReferenced: ['src/core/agent/deep-agent-factory.ts'],
      }).success,
    ).toBe(true);

    expect(
      groundedAnalysisSchema.safeParse({
        summary: 'Unverified answer',
        findings: [{ claim: 'It is probably a factory', confidence: 'certain', evidence: [] }],
        unknowns: [],
        filesReferenced: [],
      }).success,
    ).toBe(false);
  });

  it('instructs the agent to research before answering and label inference', () => {
    const prompt = buildEvidenceProtocolPrompt();

    expect(prompt).toContain('ask_codebase');
    expect(prompt).toContain('safe_read_file');
    expect(prompt).toContain('Do not answer');
    expect(prompt).toContain('inference');
  });

  it('uses preloaded evidence without requesting more tool calls in one-shot analysis', () => {
    const prompt = buildEvidenceProtocolPrompt('preloaded-manifest');

    expect(prompt).toContain('machine-collected manifest');
    expect(prompt).toContain('Do not invoke tools');
    expect(prompt).not.toContain('ask_codebase');
    expect(prompt).not.toContain('safe_read_file');
  });
});
