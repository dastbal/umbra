import { noGroundedEvidenceReport } from './retriever';

describe('retrieval abstention report', () => {
  it('returns no paths, snippets, or agent hints when evidence is insufficient', () => {
    const report = noGroundedEvidenceReport('Where is the Saturn payroll connector?');

    expect(report).toContain('NO GROUNDED EVIDENCE');
    expect(report).not.toContain('📂 **FILE:**');
    expect(report).not.toContain('CODE SNIPPETS');
    expect(report).not.toContain('AGENT HINT');
  });
});
