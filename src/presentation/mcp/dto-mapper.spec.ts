import { toErrorResult, toToolResult, withProvenance } from './dto-mapper';

/**
 * The DTO boundary is the only thing standing between Umbra's internal prompt
 * vocabulary and a foreign model's context. These assertions are deliberately
 * shaped like `ai-agent-http.module.spec.ts`'s `expect(body).not.toContain(...)`
 * checks: they assert what must never leave, not merely what should.
 */
describe('MCP DTO boundary', () => {
  it('translates an authorization denial instead of forwarding Umbra prompt vocabulary', () => {
    const result = toToolResult('❌ DENIED: The directory escapes the workspace.');

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).not.toContain('DENIED');
    expect(result.content[0]!.text).toContain('outside the workspace');
  });

  it('translates an approval requirement into the reason no approval channel exists', () => {
    const result = toToolResult('❌ APPROVAL_REQUIRED: Type check needs operator approval.');

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).not.toContain('APPROVAL_REQUIRED');
    expect(result.content[0]!.text).toContain('read-only');
  });

  it('matches the longer prefix, so APPROVAL_REQUIRED is not reported as a denial', () => {
    const approval = toToolResult('❌ APPROVAL_REQUIRED: needs a human.');
    const denial = toToolResult('❌ DENIED: escapes the workspace.');

    expect(approval.content[0]!.text).not.toEqual(denial.content[0]!.text);
  });

  it('strips agent hints that name tools this server does not publish', () => {
    const raw = [
      '🔎 **RAG ANALYSIS REPORT**',
      '📂 **FILE:** src/core/rag/retriever.ts',
      '',
      '💡 **AGENT HINT:** To edit this file or see full imports, run: read_file("src/core/rag/retriever.ts")',
      '=========',
    ].join('\n');

    const result = toToolResult(raw);

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).not.toContain('AGENT HINT');
    expect(result.content[0]!.text).not.toContain('read_file');
    expect(result.content[0]!.text).toContain('RAG ANALYSIS REPORT');
  });

  it('reports any other failure as an error rather than as an answer', () => {
    // A client that cannot tell a failure from content feeds the failure to its
    // model as fact.
    const result = toToolResult('❌ Error querying codebase: index unavailable');

    expect(result.isError).toBe(true);
  });

  it('leaves ordinary successful output intact', () => {
    const result = toToolResult('ADR catalog (cached; 26 decisions):\n- ADR-001 — …');

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain('ADR-001');
  });

  it('marks an out-of-tool failure as an error', () => {
    expect(toErrorResult('query is required.').isError).toBe(true);
  });

  describe('provenance', () => {
    it('states which embedding index produced an answer', () => {
      const text = withProvenance('answer body', {
        provider: 'ollama',
        model: 'nomic-embed-text',
        chunksSearched: 277,
      });

      expect(text).toContain('ollama/nomic-embed-text');
      expect(text).toContain('277 chunks searched');
      expect(text).toContain('answer body');
    });

    it('says so loudly when the index is incomplete', () => {
      // ADR-017's third failure was an index reporting success over missing
      // content. Here the reader is another agent with no terminal to check.
      const text = withProvenance('answer body', {
        provider: 'vertex',
        model: 'text-embedding-004',
        status: 'partial',
      });

      expect(text).toContain('INDEX INCOMPLETE');
    });

    it('declares a provider disagreement instead of quietly naming one side', () => {
      // The defect this replaced: the header was built from the launch-time
      // selection while the answer came from another provider's column, so it
      // stated an origin that was confidently wrong.
      const text = withProvenance('answer body', {
        provider: 'vertex',
        model: 'text-embedding-004',
        queriedWith: 'ollama/nomic-embed-text',
      });

      expect(text).toContain('vertex/text-embedding-004');
      expect(text).toContain('WARNING');
      expect(text).toContain('queried with ollama/nomic-embed-text');
    });

    it('stays quiet when the index and the active provider agree', () => {
      const text = withProvenance('answer body', {
        provider: 'vertex',
        model: 'text-embedding-004',
      });

      expect(text).not.toContain('WARNING');
      expect(text).not.toContain('mismatch');
    });

    it('omits what it does not know rather than inventing a default', () => {
      const text = withProvenance('body', { provider: 'vertex', model: 'text-embedding-004' });

      expect(text).not.toContain('files indexed');
      expect(text).not.toContain('indexed 1970');
    });
  });
});
