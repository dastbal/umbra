import Database from 'better-sqlite3';
import { ensureLexicalIndex } from './lexical-index';
import { assessUnknownTerms, findUnknownTerms, subjectTerms, termProbes, unknownTermReport } from './unknown-terms';

/** A minimal `code_chunks` plus its FTS mirror, standing in for a real index. */
function indexWith(contents: readonly { path: string; content: string }[]): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE code_chunks (
      id TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      metadata TEXT,
      content TEXT NOT NULL
    );
  `);
  ensureLexicalIndex(db);

  const insert = db.prepare(
    'INSERT INTO code_chunks (id, file_path, metadata, content) VALUES (?, ?, ?, ?)',
  );
  contents.forEach((entry, index) => insert.run(`c${index}`, entry.path, '{}', entry.content));
  return db;
}

describe('subjectTerms', () => {
  it('drops English function words, which carry grammar rather than subject', () => {
    expect(subjectTerms('Where does the module resolve its provider?')).toEqual([
      'module',
      'resolve',
      'provider',
    ]);
  });

  it('drops terms shorter than four characters', () => {
    expect(subjectTerms('is a db ok')).toEqual([]);
  });

  it('lowercases and de-duplicates', () => {
    expect(subjectTerms('Provider provider PROVIDER')).toEqual(['provider']);
  });

  it('survives punctuation without treating it as a term', () => {
    expect(subjectTerms('retriever.query() — where?')).toEqual(['retriever', 'query']);
  });
});

describe('findUnknownTerms', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = indexWith([
      {
        path: 'src/core/rag/retrieval-metrics.ts',
        content: 'export function scoreCase(): void {} // metrics for the retrieval endpoint, handle it',
      },
      {
        path: 'src/core/rag/retriever.ts',
        content: 'export class RetrieverService { query() {} } // defines how a query is handled',
      },
    ]);
  });

  afterEach(() => db.close());

  // The measured failure: `metrics` matched a filename and carried the whole
  // grounding decision, while `prometheus` was never required to match anything.
  it('names the term that made the question specific and matches nothing', () => {
    const unknown = findUnknownTerms(db, 'Where does Umbra expose a Prometheus metrics endpoint?');

    expect(unknown).toContain('prometheus');
    // The words that used to carry the whole decision are present, and the rule
    // does not care: one absent subject term is enough to abstain.
    expect(unknown).not.toContain('metrics');
    expect(unknown).not.toContain('endpoint');
  });

  it('returns nothing when every subject term exists somewhere in the index', () => {
    expect(findUnknownTerms(db, 'Where is the retriever query defined?')).toEqual([]);
  });

  it('does not abstain on an inflected form of a word the code contains', () => {
    // 'handled' is not in the source; 'handle' is. Abstaining on morphology
    // rather than on subject would make the rule worse than what it replaces.
    expect(findUnknownTerms(db, 'Where is retrieval handled?')).toEqual([]);
  });

  it('treats a query of only function words as having nothing to check', () => {
    expect(findUnknownTerms(db, 'where is this from')).toEqual([]);
  });

  it('does not throw on an empty or symbol-only query', () => {
    expect(findUnknownTerms(db, '')).toEqual([]);
    expect(findUnknownTerms(db, '??? *** ---')).toEqual([]);
  });

  it('does not let a quote in the query become FTS syntax', () => {
    expect(() => findUnknownTerms(db, 'where is "kafka" OR retriever')).not.toThrow();
    expect(findUnknownTerms(db, 'where is "kafka" OR retriever')).toContain('kafka');
  });

  it('degrades a repeated manner modifier without hiding a missing subject', () => {
    const assessment = assessUnknownTerms(
      db,
      'How is the retriever query handled byte by byte?',
    );

    expect(assessment.strict).toEqual([]);
    expect(assessment.ignoredModifiers).toEqual(['byte']);
    expect(assessment.droppedTerms).toEqual([]);
  });

  it('keeps the same word strict when it is the only possible subject', () => {
    const assessment = assessUnknownTerms(db, 'Where are bytes handled?');

    expect(assessment.strict).toEqual(['bytes']);
    expect(assessment.ignoredModifiers).toEqual([]);
    expect(assessment.droppedTerms).toEqual([]);
  });

  // The shape of every nonexistent-feature question: the absent name arrives
  // with grounded words around it. Excusing it because they are grounded is
  // what shipped in 2.2.11 and answered all ten gate negatives.
  it('keeps an unknown subject strict however many other subjects are grounded', () => {
    const assessment = assessUnknownTerms(db, 'Where does Umbra expose a Prometheus metrics endpoint?');

    expect(assessment.strict).toContain('prometheus');
    expect(assessment.droppedTerms).toEqual([]);
  });

  it('does not let one grounded subject excuse the unknown ones beside it', () => {
    const assessment = assessUnknownTerms(db, 'Compare the retriever signature byte by byte');

    expect(assessment.strict).toEqual(['compare', 'signature', 'byte']);
    expect(assessment.droppedTerms).toEqual([]);
  });
});

describe('termProbes', () => {
  it('reaches every spelling of a word whose y becomes i under inflection', () => {
    const db = indexWith([
      { path: 'src/probe.ts', content: 'export function probe(): void {} // verified when the provider verifies' },
      { path: 'src/query.ts', content: 'export class Query {} // one query per request' },
    ]);

    // The base form the code never wrote, against the inflections it did.
    expect(findUnknownTerms(db, 'Where does the provider verify?')).toEqual([]);
    // The inflection the code never wrote, against the base form it did.
    expect(findUnknownTerms(db, 'Where are queries built?')).not.toContain('queries');
    db.close();
  });

  it('probes the shared root only after a consonant', () => {
    expect(termProbes('verify')).toEqual(['"verify"', '"verif"*']);
    expect(termProbes('queries')).toEqual(['"queries"', '"queri"*', '"quer"*']);
    // `deploy` keeps its y in `deployed`; there is no other spelling to reach.
    expect(termProbes('deploy')).toEqual(['"deploy"']);
  });

  it('keeps the exact probe when the root would be too short to mean anything', () => {
    // `den*` would find `dense` and call an absent word present.
    expect(termProbes('deny')).toEqual(['"deny"']);
  });

  it('leaves the other inflections as they were', () => {
    expect(termProbes('handled')).toEqual(['"handled"', '"handl"*']);
    expect(termProbes('uses')).toEqual(['"uses"', '"use"*']);
    expect(termProbes('retriever')).toEqual(['"retriever"']);
  });
});

describe('unknownTermReport', () => {
  it('names the unrecognised term, so absence is distinguishable from failure', () => {
    const report = unknownTermReport('Where is the Kafka topic?', ['kafka']);

    expect(report).toContain('NO GROUNDED EVIDENCE');
    expect(report).toContain('`kafka`');
    expect(report).toContain('evidence the feature is absent');
  });

  it('leaks no path or snippet', () => {
    const report = unknownTermReport('Where is the Kafka topic?', ['kafka']);

    expect(report).not.toContain('**FILE:**');
    expect(report).not.toContain('src/');
  });
});
