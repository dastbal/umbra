import Database from 'better-sqlite3';
import {
  RetrievalMemoryService,
  ensureRetrievalMemory,
  normalizeRetrievalTerms,
} from './retrieval-memory';

describe('retrieval memory', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    ensureRetrievalMemory(db);
  });

  afterEach(() => db.close());

  it('drops conversational filler before an alias can be stored', () => {
    expect(normalizeRetrievalTerms('bello, dale buscame files del RAG por favor'))
      .toEqual(['files', 'rag']);
  });

  it('expands a later query only from explicitly approved local evidence', () => {
    const memory = new RetrievalMemoryService(db);

    expect(memory.expand('files RAG')).toBe('files rag');
    expect(memory.approve({
      triggerTerms: ['files', 'RAG'],
      contextTerms: ['retriever service', 'embeddings'],
      verifiedPaths: ['src/core/rag/retriever.ts'],
    })).toBe(true);

    expect(memory.expand('bello files RAG')).toBe('files rag retriever service embeddings');
  });

  it('refuses aliases without verified source paths', () => {
    const memory = new RetrievalMemoryService(db);

    expect(memory.approve({
      triggerTerms: ['rag'],
      contextTerms: ['retriever'],
      verifiedPaths: [],
    })).toBe(false);
  });
});
