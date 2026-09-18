import { RetrieverService, SearchResult, noGroundedEvidenceReport } from './retriever';
import { assessUnknownTerms } from './unknown-terms';

/**
 * The unknown-term gate reads this machine's own index, so leaving it live made
 * these tests assert different things on different machines: locally the index
 * holds 1022 rows and `files`/`rag` are known, so retrieval ran; in CI nothing
 * is indexed, every term is therefore unknown, and the gate abstained before
 * `query` was ever called. The retry test failed there for a reason that had
 * nothing to do with retrying.
 *
 * Stubbing it is the same correction `useEmptyProject` made in
 * `embeddings.spec.ts`: a test that depends on the machine it runs on is not
 * testing what it claims to. Only `assessUnknownTerms` is replaced — the reports
 * these tests assert on stay real, so the wiring from gate to abstention is
 * still exercised end to end. The gate's own judgement belongs to
 * `unknown-terms.spec.ts`, which owns it.
 */
jest.mock('./unknown-terms', () => ({
  ...jest.requireActual('./unknown-terms'),
  assessUnknownTerms: jest.fn(),
}));

const gate = assessUnknownTerms as jest.MockedFunction<typeof assessUnknownTerms>;

function result(evidence: SearchResult['evidence'], filePath = 'src/core/rag/retriever.ts'): SearchResult {
  return {
    score: 1,
    evidence,
    lexicalExact: evidence === 'lexical',
    chunk: {
      id: `${evidence}-chunk`,
      type: 'method',
      content: 'export class RetrieverService {}',
      filePath,
      metadata: { startLine: 1, endLine: 1, className: 'RetrieverService' },
    },
  };
}

describe('retrieval abstention report', () => {
  it('returns no paths, snippets, or agent hints when evidence is insufficient', () => {
    const report = noGroundedEvidenceReport('Where is the Saturn payroll connector?');

    expect(report).toContain('NO GROUNDED EVIDENCE');
    expect(report).not.toContain('📂 **FILE:**');
    expect(report).not.toContain('CODE SNIPPETS');
    expect(report).not.toContain('AGENT HINT');
  });
});

describe('contextual retrieval retry', () => {
  it('runs exactly one contextual retry after an ungrounded first result', async () => {
    // Every term is known, so the gate lets the question through and what this
    // test measures is the retry itself.
    gate.mockReturnValue({ strict: [], ignoredModifiers: [], droppedTerms: [] });

    const retriever = new RetrieverService({
      identity: { provider: 'ollama', model: 'test', dimensions: 3, column: 'vector_ollama_json' },
      embedQuery: jest.fn(),
      embedDocuments: jest.fn(),
    });
    const query = jest.spyOn(retriever, 'query')
      .mockResolvedValueOnce([result('semantic')])
      .mockResolvedValueOnce([result('hybrid')]);

    const report = await retriever.getContextForLLM(
      'bello files RAG',
      'the service that retrieves embeddings',
    );

    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenNthCalledWith(1, 'bello files RAG', 4);
    expect(query).toHaveBeenNthCalledWith(2, 'bello files RAG\nthe service that retrieves embeddings', 4);
    expect(report).toContain('📂 **FILE:** src/core/rag/retriever.ts');
    expect(retriever.learningCandidate).toEqual(expect.objectContaining({
      triggerTerms: ['files', 'rag'],
      contextTerms: ['service', 'that', 'retrieves', 'embeddings'],
    }));
  });

  it('does not retry when no clarification was supplied', async () => {
    // The question names something the repository never wrote. Declared here
    // rather than inherited from whatever this machine happens to have indexed.
    gate.mockReturnValue({ strict: ['saturn', 'payroll'], ignoredModifiers: [], droppedTerms: [] });

    const retriever = new RetrieverService({
      identity: { provider: 'ollama', model: 'test', dimensions: 3, column: 'vector_ollama_json' },
      embedQuery: jest.fn(),
      embedDocuments: jest.fn(),
    });
    const query = jest.spyOn(retriever, 'query').mockResolvedValue([result('semantic')]);

    const report = await retriever.getContextForLLM('where is Saturn payroll');

    // Was `toHaveBeenCalledTimes(1)`. The unknown-term gate now reaches the same
    // abstention before embedding anything, so the retrieval never runs at all.
    // The outcome the test was written to protect is unchanged; what changed is
    // that it no longer costs an embedding call.
    //
    // The original note explained this as holding "because this repository
    // contains no occurrence of `saturn` or `payroll`". That was true, and it is
    // precisely what made this pair machine-dependent — the gate is stubbed
    // above now, so the condition is declared rather than inherited.
    expect(query).not.toHaveBeenCalled();
    expect(report).toContain('NO GROUNDED EVIDENCE');
    expect(report).toContain('`saturn`');
  });
});
