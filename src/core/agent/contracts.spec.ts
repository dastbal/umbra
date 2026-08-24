import {
  AgentRole,
  AgentTaskResult,
  ResearchArtifact,
  researchArtifactSchema,
  TaskComplexity,
  VerificationArtifact,
  verificationArtifactSchema,
} from './contracts';

describe('agent contracts', () => {
  it('represents the adaptive orchestration roles', () => {
    const roles: AgentRole[] = ['supervisor', 'researcher', 'coder', 'verifier'];
    const complexities: TaskComplexity[] = ['small', 'medium', 'large'];

    expect(roles).toHaveLength(4);
    expect(complexities).toHaveLength(3);
  });

  it('supports a compact researcher handoff', () => {
    const artifact: ResearchArtifact = {
      status: 'ready',
      objective: 'Add a users endpoint',
      relevantFiles: ['src/users/users.controller.ts'],
      findings: ['The module uses application services'],
      evidence: [
        {
          path: 'src/users/users.controller.ts',
          claim: 'The controller delegates to an application service',
          kind: 'direct',
        },
      ],
      decisions: ['Keep the controller thin'],
      risks: ['Missing authorization guard'],
      testPlan: ['Add a controller happy-path spec'],
      constraints: ['Do not modify authentication'],
      nextAction: 'Implement the endpoint',
    };

    expect(artifact.status).toBe('ready');
    expect(artifact.relevantFiles).toContain('src/users/users.controller.ts');
  });

  it('represents verification results and task output', () => {
    const verification: VerificationArtifact = {
      status: 'passed',
      typeCheckPassed: true,
      testsPassed: true,
      changedFiles: ['src/users/users.controller.ts'],
      remainingIssues: [],
      nextAction: 'Report completion',
    };
    const result: AgentTaskResult = {
      status: 'completed',
      summary: 'Endpoint implemented and verified',
      decisions: ['Kept business logic in the application layer'],
      changedFiles: verification.changedFiles,
      verification,
      risks: [],
      costUsd: 0.12,
    };

    expect(result.verification.testsPassed).toBe(true);
    expect(result.costUsd).toBeGreaterThanOrEqual(0);
  });

  it('validates compact handoff artifacts at the subagent boundary', () => {
    expect(
      researchArtifactSchema.safeParse({
        status: 'ready',
        objective: 'Inspect the module',
        relevantFiles: [],
        findings: [],
        evidence: [
          {
            path: 'src/core/agent/deep-agent-factory.ts',
            claim: 'The factory is the active entry point',
            kind: 'direct',
          },
        ],
        decisions: [],
        risks: [],
        testPlan: [],
        constraints: [],
        nextAction: 'Return the plan',
      }).success,
    ).toBe(true);

    expect(
      verificationArtifactSchema.safeParse({
        status: 'passed',
        typeCheckPassed: true,
        testsPassed: true,
        changedFiles: [],
        remainingIssues: [],
        nextAction: 'Report completion',
      }).success,
    ).toBe(true);
  });
});
