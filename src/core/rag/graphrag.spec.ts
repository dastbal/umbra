import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { formatGraphRagContextForLLM, GraphRagService } from './graphrag';
import type { RetrievalContextResult, RetrieverService } from './retriever';

const UNIQUE_SECRET = 'private-source-must-never-appear-in-detective-trace';

describe('GraphRagService', () => {
  let db: Database.Database;
  let rootDir: string;
  let retrieve: jest.Mock<Promise<RetrievalContextResult>, [string, string?]>;

  beforeEach(() => {
    db = createStore();
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-graphrag-'));
    populateCompleteGraph(db);
    retrieve = jest.fn<Promise<RetrievalContextResult>, [string, string?]>(
      async () => seedContext(),
    );
  });

  afterEach(() => {
    db.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('reuses one grounded hybrid lookup while dependency traversal adds source evidence', async () => {
    const service = new GraphRagService(fakeRetriever(retrieve), db, rootDir);

    const result = await service.search('where does EntryService delegate?');

    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.strategy.plan).toBe('dependency-2');
    expect(result.files.map((file) => [file.filePath, file.origin])).toEqual([
      ['src/entry.ts', 'seed'],
      ['src/target.ts', 'graph'],
    ]);
    expect(result.strategy.relationsInspected).toBeGreaterThanOrEqual(1);
  });

  it('stops after a non-contributing hop and leaves a marginal-evidence receipt', async () => {
    const service = new GraphRagService(fakeRetriever(retrieve), db, rootDir);

    const result = await service.search('where does EntryService delegate?');

    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.strategy.stopReason).toBe('marginal-evidence');
    expect(result.strategy.marginalEvidence).toEqual([
      expect.objectContaining({ depth: 1, frontierNodes: 1, novelEvidence: 1 }),
      expect.objectContaining({ depth: 2, frontierNodes: 1, novelEvidence: 0 }),
    ]);
  });

  it('executes each Detective graph plan once and projects its existing traversal ledger', async () => {
    const prepare = jest.spyOn(db, 'prepare');
    const service = new GraphRagService(fakeRetriever(retrieve), db, rootDir);

    await service.investigate('where does EntryService delegate?');

    expect(retrieve).toHaveBeenCalledTimes(1);
    const dependencyTraversalQueries = prepare.mock.calls.filter(([sql]) =>
      typeof sql === 'string' && sql.includes('FROM dependency_graph WHERE source = ? OR target = ?'),
    );
    // dependency-1 inspects exactly one live frontier level. dependency-2 and
    // combined inspect two; a second traversal solely for trace rendering
    // would double the expected five reads.
    expect(dependencyTraversalQueries).toHaveLength(5);
  });

  it('caps dependency-1 at one outgoing hop even when the mode budget permits more', async () => {
    const service = new GraphRagService(fakeRetriever(retrieve), db, rootDir);

    const trace = await service.investigate('where does EntryService delegate?');
    const dependencyOne = trace.plans.find((plan) => plan.plan === 'dependency-1');

    expect(dependencyOne?.metrics).toMatchObject({ depthReached: 1, stopReason: 'depth-budget' });
    expect(dependencyOne?.metrics.marginalEvidence).toHaveLength(1);
  });

  it('labels the configured policy and executed plan separately in the agent receipt', async () => {
    const service = new GraphRagService(fakeRetriever(retrieve), db, rootDir);

    const result = await service.search('where does EntryService delegate?');

    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(formatGraphRagContextForLLM(result)).toContain('policy: balanced-v1');
    expect(formatGraphRagContextForLLM(result)).toContain('plan: dependency-2');
    expect(formatGraphRagContextForLLM(result)).toContain('nodesVisited:');
    expect(formatGraphRagContextForLLM(result)).toContain('relationsInspected:');
    expect(formatGraphRagContextForLLM(result)).toContain('stopReason:');
  });

  it('traverses dependency relationships in both directions for dependency-2', async () => {
    retrieve.mockResolvedValue({
      status: 'success', query: 'who imports TargetService?', recoveredWithContext: false, ignoredModifiers: [], droppedTerms: [],
      files: [{
        filePath: 'src/target.ts', evidence: 'hybrid', imports: [],
        chunks: [{
          id: 'target', filePath: 'src/target.ts', type: 'file', content: 'export class TargetService {}',
          metadata: { startLine: 1, endLine: 1, className: 'TargetService' },
        }],
      }],
    });
    const service = new GraphRagService(fakeRetriever(retrieve), db, rootDir);

    const result = await service.search('who imports TargetService?');

    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.files.map((file) => file.filePath)).toContain('src/entry.ts');
  });

  it('uses the complete NestJS projection when an approved policy requests wiring evidence', async () => {
    const configPath = path.join(rootDir, '.umbra', 'agent.config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ rag: { retrievalPolicy: 'nest-v1' } }));
    db.prepare(
      'INSERT INTO nest_bindings (file_path, module, kind, token, use_kind, dynamic) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('src/entry.ts', 'AppModule', 'provider', 'AGENT_TOKEN', null, 0);
    db.prepare(
      'INSERT INTO nest_injections (file_path, consumer, token, explicit) VALUES (?, ?, ?, ?)',
    ).run('src/target.ts', 'TargetService', 'AGENT_TOKEN', 1);
    const service = new GraphRagService(fakeRetriever(retrieve), db, rootDir);

    const result = await service.search('where is AGENT_TOKEN injected?');

    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.strategy.plan).toBe('nest');
    expect(result.files.map((file) => file.filePath)).toContain('src/target.ts');
  });

  it('names the exact file that prevents a NestJS graph plan from running', async () => {
    db.prepare('DELETE FROM nest_scan WHERE file_path = ?').run('src/target.ts');
    const service = new GraphRagService(fakeRetriever(retrieve), db, rootDir);

    const result = await service.search('where does EntryService delegate?');

    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.strategy.readiness.nest).toMatchObject({
      ready: false,
      pendingFiles: 1,
      affectedPaths: ['src/target.ts'],
    });
    expect(result.strategy.readiness.nest.reason).toContain('src/target.ts');
  });

  it('never uses a stale dependency projection when the independent NestJS projection is available', async () => {
    db.prepare('DELETE FROM dependency_scan WHERE file_path = ?').run('src/target.ts');
    const service = new GraphRagService(fakeRetriever(retrieve), db, rootDir);

    const result = await service.search('where does EntryService delegate?');

    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.strategy.plan).toBe('nest');
    expect(result.files.map((file) => file.filePath)).toEqual(['src/entry.ts']);
    expect(result.strategy.readiness.dependency.ready).toBe(false);
  });

  it('recommends the Nest graph only with a stored NestJS token, never a file path', async () => {
    db.prepare('DELETE FROM dependency_graph').run();
    db.prepare(
      'INSERT INTO nest_bindings (file_path, module, kind, token, use_kind, dynamic) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('src/entry.ts', 'AppModule', 'provider', 'AGENT_TOKEN', null, 0);
    const service = new GraphRagService(fakeRetriever(retrieve), db, rootDir);

    const result = await service.search('where does EntryService delegate?');

    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.strategy.recommendation).toMatchObject({
      state: 'follow-up', tool: 'query_nest_graph', subject: 'AGENT_TOKEN',
    });
  });

  it('enforces the selected-context budget even when an upstream retriever over-returns chunks', async () => {
    retrieve.mockResolvedValue({
      status: 'success',
      query: 'oversized context',
      recoveredWithContext: false,
      ignoredModifiers: [],
      droppedTerms: [],
      files: [{
        filePath: 'src/entry.ts', evidence: 'hybrid', imports: [],
        chunks: Array.from({ length: 10 }, (_, index) => ({
          id: `seed-${index}`, filePath: 'src/entry.ts', type: 'file' as const,
          content: `export const source${index} = true;`,
          metadata: { startLine: index + 1, endLine: index + 1 },
        })),
      }],
    });
    const service = new GraphRagService(fakeRetriever(retrieve), db, rootDir);

    const result = await service.search('oversized context');

    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.files.flatMap((file) => file.chunks)).toHaveLength(8);
    expect(result.strategy.estimatedTokens).toBeLessThanOrEqual(8_000);
  });

  it('reserves room for accepted graph evidence instead of letting oversized seeds consume the whole answer', async () => {
    retrieve.mockResolvedValue({
      status: 'success',
      query: 'oversized graph context',
      recoveredWithContext: false,
      ignoredModifiers: [],
      droppedTerms: [],
      files: [{
        filePath: 'src/entry.ts', evidence: 'hybrid', imports: [],
        chunks: Array.from({ length: 12 }, (_, index) => ({
          id: `seed-${index}`, filePath: 'src/entry.ts', type: 'file' as const,
          content: `export const source${index} = true;`,
          metadata: { startLine: index + 1, endLine: index + 1 },
        })),
      }],
    });
    const service = new GraphRagService(fakeRetriever(retrieve), db, rootDir);

    const result = await service.search('oversized graph context');

    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.files.map((file) => file.filePath)).toContain('src/target.ts');
  });

  it('stores the question and metadata but never source snippets in Detective traces', async () => {
    const service = new GraphRagService(fakeRetriever(retrieve), db, rootDir);

    const trace = await service.investigate('trace privacy question');
    const stored = fs.readFileSync(path.join(rootDir, '.umbra', 'detective', `${trace.id}.json`), 'utf8');

    expect(stored).toContain('trace privacy question');
    expect(stored).toContain('src/target.ts');
    expect(stored).not.toContain(UNIQUE_SECRET);
  });

  it('serves an MCP-safe comparison without retaining the caller question as a local trace', async () => {
    const service = new GraphRagService(fakeRetriever(retrieve), db, rootDir);

    const trace = await service.compare('MCP private comparison question');

    expect(trace.query).toBe('MCP private comparison question');
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(rootDir, '.umbra', 'detective', `${trace.id}.json`))).toBe(false);
  });

  it('scores a Detective plan only when the project supplies a matching labelled corpus case', async () => {
    retrieve.mockResolvedValue({ ...seedContext(), query: 'Where is EntryService defined?' });
    const corpusPath = path.join(rootDir, 'docs', 'benchmarks', 'embedding-retrieval-corpus.json');
    fs.mkdirSync(path.dirname(corpusPath), { recursive: true });
    fs.writeFileSync(corpusPath, JSON.stringify({ queries: [{
      id: 'entry-service', split: 'calibration', query: 'Where is EntryService defined?',
      expectedPaths: ['src/entry.ts'],
    }] }));
    const service = new GraphRagService(fakeRetriever(retrieve), db, rootDir);

    const trace = await service.investigate('Where is EntryService defined?');
    const hybrid = trace.plans.find((plan) => plan.plan === 'hybrid');

    expect(hybrid?.quality).toMatchObject({
      corpusCaseId: 'entry-service', sampleSize: 1, hitAt1: 1, mrr: 1, falseAbstention: false,
    });
  });

  it('refuses a direct replay comparison after the indexed corpus fingerprint changes', async () => {
    const service = new GraphRagService(fakeRetriever(retrieve), db, rootDir);
    const first = await service.investigate('replay question');
    db.prepare('UPDATE file_registry SET hash = ? WHERE path = ?').run('changed-hash', 'src/target.ts');

    const replay = await service.replay(first.id);

    expect(replay.comparable).toBe(false);
    expect(replay.reason).toMatch(/fingerprint changed/i);
  });

  it('promotes only an explicitly selected policy and preserves unrelated local configuration', async () => {
    const configPath = path.join(rootDir, '.umbra', 'agent.config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ models: { coder: 'ollama:gemma4' }, rag: { embeddings: 'ollama' } }));
    const service = new GraphRagService(fakeRetriever(retrieve), db, rootDir);
    await service.investigate('promotion evidence');

    const promotion = service.promote('dependency-2-v1');
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      models: { coder: string };
      rag: { embeddings: string; retrievalPolicy: string };
    };

    expect(promotion.promoted).toBe(true);
    expect(saved.models.coder).toBe('ollama:gemma4');
    expect(saved.rag).toEqual({ embeddings: 'ollama', retrievalPolicy: 'dependency-2-v1' });
  });
});

/** Creates the smallest complete SQLite projection that GraphRAG reads. */
function createStore(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE file_registry (
      path TEXT PRIMARY KEY,
      hash TEXT NOT NULL,
      index_state TEXT NOT NULL,
      skeleton_signature TEXT
    );
    CREATE TABLE code_chunks (
      id TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      chunk_type TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT NOT NULL
    );
    CREATE TABLE dependency_graph (
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      relation TEXT NOT NULL
    );
    CREATE TABLE dependency_scan (file_path TEXT PRIMARY KEY, hash TEXT NOT NULL);
    CREATE TABLE nest_bindings (
      file_path TEXT NOT NULL, module TEXT NOT NULL, kind TEXT NOT NULL, token TEXT NOT NULL,
      use_kind TEXT, dynamic INTEGER NOT NULL
    );
    CREATE TABLE nest_injections (
      file_path TEXT NOT NULL, consumer TEXT NOT NULL, token TEXT NOT NULL, explicit INTEGER NOT NULL
    );
    CREATE TABLE nest_scan (file_path TEXT PRIMARY KEY, hash TEXT NOT NULL);
  `);
  return db;
}

/** Adds two indexed files joined by a dependency, with current graph scans. */
function populateCompleteGraph(db: Database.Database): void {
  const register = db.prepare(
    "INSERT INTO file_registry (path, hash, index_state, skeleton_signature) VALUES (?, ?, 'indexed', NULL)",
  );
  register.run('src/entry.ts', 'entry-hash');
  register.run('src/target.ts', 'target-hash');
  const chunk = db.prepare(
    'INSERT INTO code_chunks (id, file_path, chunk_type, content, metadata) VALUES (?, ?, ?, ?, ?)',
  );
  chunk.run('entry', 'src/entry.ts', 'file', 'export class EntryService {}', metadata('EntryService'));
  chunk.run('target', 'src/target.ts', 'file', `export const secret = '${UNIQUE_SECRET}';`, metadata('TargetService'));
  db.prepare('INSERT INTO dependency_graph (source, target, relation) VALUES (?, ?, ?)')
    .run('src/entry.ts', 'src/target.ts', 'import');
  const scan = db.prepare('INSERT INTO dependency_scan (file_path, hash) VALUES (?, ?)');
  scan.run('src/entry.ts', 'entry-hash');
  scan.run('src/target.ts', 'target-hash');
  const nestScan = db.prepare('INSERT INTO nest_scan (file_path, hash) VALUES (?, ?)');
  nestScan.run('src/entry.ts', 'entry-hash');
  nestScan.run('src/target.ts', 'target-hash');
}

/** Returns valid indexed chunk metadata. */
function metadata(className: string): string {
  return JSON.stringify({ startLine: 1, endLine: 1, className });
}

/** Produces one grounded hybrid retrieval result used as deterministic graph seeds. */
function seedContext(): RetrievalContextResult {
  return {
    status: 'success',
    query: 'where does EntryService delegate?',
    recoveredWithContext: false,
    ignoredModifiers: [],
    droppedTerms: [],
    files: [{
      filePath: 'src/entry.ts',
      evidence: 'hybrid',
      imports: ['src/target.ts'],
      chunks: [{
        id: 'entry', filePath: 'src/entry.ts', type: 'file', content: 'export class EntryService {}',
        metadata: { startLine: 1, endLine: 1, className: 'EntryService' },
      }],
    }],
  };
}

/** Supplies only the RetrieverService surface GraphRAG needs in this fixture. */
function fakeRetriever(
  getContext: jest.Mock<Promise<RetrievalContextResult>, [string, string?]>,
): RetrieverService {
  return { getContext, learningCandidate: undefined } as unknown as RetrieverService;
}
