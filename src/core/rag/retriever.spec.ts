import { RetrieverService, SearchResult, noGroundedEvidenceReport } from './retriever';

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
    const retriever = new RetrieverService({
      identity: { provider: 'ollama', model: 'test', dimensions: 3, column: 'vector_ollama_json' },
      embedQuery: jest.fn(),
      embedDocuments: jest.fn(),
    });
    const query = jest.spyOn(retriever, 'query').mockResolvedValue([result('semantic')]);

    const report = await retriever.getContextForLLM('where is Saturn payroll');

    expect(query).toHaveBeenCalledTimes(1);
    expect(report).toContain('NO GROUNDED EVIDENCE');
  });
});
