import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { agentPath } from '../config/agent-directory';
import { pinRuntimeRoot, resetRuntimeRoot } from '../config/runtime-root';
import { AgentDB } from '../state/db';
import { loadVectorExtensionInto } from '../state/vector-extension';
import { executeCodebaseSearch, executeDependencyGraph, type WorktreeIndexScope } from '../tools/read-only-executions';
import type { EmbeddingsPort } from './embeddings';
import { GraphRagService } from './graphrag';
import { IndexerService } from './indexer';
import { RetrieverService } from './retriever';
import { OverlayBusyError, OverlayScope } from './overlay-scope';
import { resetWorktreeDeltaCache } from './worktree-delta';
import { WorktreeViewService } from './worktree-view';

/**
 * The worktree view end to end, on a real git repository, a real index, and a
 * real linked worktree (ADR-038).
 *
 * The embeddings are a deterministic bag of words, so the assertions are about
 * what the overlay makes visible and invisible — never about ranking quality,
 * which the retrieval gate and the live benchmark own.
 */

/** Runs git with a fixed identity so commits work on any machine. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
}

/** Hashes each word into one of 64 dimensions: similar text, similar vector, no provider. */
function bagOfWords(text: string): number[] {
  const vector = new Array<number>(64).fill(0);
  for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    vector[crypto.createHash('md5').update(word).digest()[0]! % 64]! += 1;
  }
  const norm = Math.sqrt(vector.reduce((total, value) => total + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

/** A provider that counts its calls. */
function countingEmbeddings(): EmbeddingsPort & { documents: number; queries: number } {
  const port = {
    identity: { provider: 'ollama' as const, model: 'bag-of-words', dimensions: 64, column: 'vector_ollama_json' as const },
    documents: 0,
    queries: 0,
    embedQuery: async (text: string) => {
      port.queries += 1;
      return bagOfWords(text);
    },
    embedDocuments: async (texts: string[]) => {
      port.documents += texts.length;
      return texts.map(bagOfWords);
    },
  };
  return port;
}

/** Row counts that must be identical before and after any worktree read. */
function baseFingerprint(dbPath: string): Record<string, unknown> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const count = (table: string): number => (db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number }).total;
    return {
      files: count('file_registry'),
      chunks: count('code_chunks'),
      vectors: count('chunk_vectors'),
      fts: count('code_chunks_fts'),
      edges: count('dependency_graph'),
      trigger: db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'trigger' AND name = 'code_chunks_fts_delete'").get() !== undefined,
      hashes: (db.prepare('SELECT path, hash FROM file_registry ORDER BY path').all() as { path: string; hash: string }[])
        .map((row) => `${row.path}:${row.hash}`).join(','),
    };
  } finally {
    db.close();
  }
}

describe('WorktreeViewService', () => {
  let base: string;
  let repo: string;
  let linked: string;
  let dbPath: string;
  let embeddings: ReturnType<typeof countingEmbeddings>;
  let views: WorktreeViewService;

  /** The base index's answer, with the same deterministic provider the index was built with. */
  const baseStatus = async (query: string): Promise<string> =>
    (await new GraphRagService(new RetrieverService(embeddings)).search(query)).status;

  const scopeFor = (worktreePath: string): Promise<WorktreeIndexScope> => views.resolve(worktreePath).then((worktree) => ({
    read: (read) => views.read(worktree, { embed: true }, read),
  }));

  beforeEach(async () => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-worktree-view-')));
    repo = path.join(base, 'repo');
    const write = (relative: string, content: string): void => {
      fs.mkdirSync(path.dirname(path.join(repo, relative)), { recursive: true });
      fs.writeFileSync(path.join(repo, relative), content, 'utf8');
    };
    write('package.json', '{"name":"fixture"}');
    write('tsconfig.json', '{"include":["src/**/*.ts"]}');
    write('.gitignore', '.umbra/\n.claude/\n');
    write('src/payments/payment.service.ts', [
      "import { LedgerService } from '../legacy/ledger.service';",
      '',
      '/** Takes payments. */',
      'export class PaymentService {',
      '  constructor(private readonly ledger: LedgerService) {}',
      '',
      '  /** Refunds an order. */',
      '  refundOrder(orderId: string): string {',
      "    return 'refund ' + orderId;",
      '  }',
      '}',
      '',
    ].join('\n'));
    write('src/users/user.service.ts', [
      '/** Finds users. */',
      'export class UserService {',
      '  /** Looks a user up by email. */',
      '  findUserByEmail(email: string): string {',
      '    return email;',
      '  }',
      '}',
      '',
    ].join('\n'));
    write('src/legacy/ledger.service.ts', [
      '/** The old ledger. */',
      'export class LedgerService {',
      '  /** Reconciles ledger totals. */',
      '  reconcileLedgerTotals(): number {',
      '    return 0;',
      '  }',
      '}',
      '',
    ].join('\n'));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');

    // An uncommitted edit in the main checkout, indexed before any worktree
    // exists: the index now holds a version no commit has.
    fs.appendFileSync(path.join(repo, 'src/users/user.service.ts'), [
      '',
      '/** Allows impersonation by support staff. */',
      'export class ImpersonationGuard {',
      '  allowImpersonation(): boolean {',
      '    return false;',
      '  }',
      '}',
      '',
    ].join('\n'));

    pinRuntimeRoot(repo);
    IndexerService.silent = true;
    embeddings = countingEmbeddings();
    await new IndexerService(embeddings).indexProject();
    dbPath = agentPath(repo, 'memory.db');
    // `loadVectorExtension` memoizes per process, and each test reopens the
    // singleton; production opens it once.
    loadVectorExtensionInto(AgentDB.getInstance());

    linked = path.join(repo, '.claude', 'worktrees', 'feature');
    git(repo, 'worktree', 'add', '-q', '-b', 'feature', linked);
    // The worktree: one file edited, one added, one deleted.
    fs.writeFileSync(path.join(linked, 'src/payments/payment.service.ts'), [
      "import { DisputeService } from '../disputes/dispute.service';",
      '',
      '/** Takes payments. */',
      'export class PaymentService {',
      '  constructor(private readonly disputes: DisputeService) {}',
      '',
      '  /** Refunds an order. */',
      '  refundOrder(orderId: string): string {',
      "    return 'refund ' + orderId;",
      '  }',
      '',
      '  /** Opens a chargeback for a disputed payment. */',
      '  issueChargeback(paymentId: string): string {',
      '    return this.disputes.openArbitration(paymentId);',
      '  }',
      '}',
      '',
    ].join('\n'));
    fs.mkdirSync(path.join(linked, 'src/disputes'), { recursive: true });
    fs.writeFileSync(path.join(linked, 'src/disputes/dispute.service.ts'), [
      '/** Handles card disputes. */',
      'export class DisputeService {',
      '  /** Sends a dispute to arbitration. */',
      '  openArbitration(paymentId: string): string {',
      "    return 'arbitration ' + paymentId;",
      '  }',
      '}',
      '',
    ].join('\n'));
    fs.rmSync(path.join(linked, 'src/legacy/ledger.service.ts'));

    resetWorktreeDeltaCache();
    views = new WorktreeViewService({
      pinnedRoot: repo,
      baseDb: AgentDB.getInstance(),
      dbPath,
      embeddings,
      isIndexing: () => IndexerService.running,
    });
  });

  afterEach(() => {
    views.close();
    AgentDB.close();
    resetRuntimeRoot();
    IndexerService.silent = false;
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('finds what only the worktree has, and abstains on what only the worktree lost', async () => {
    const scope = await scopeFor(linked);

    const chargebackWorktree = (await executeCodebaseSearch({ query: 'chargeback' }, scope)).result;
    expect(await baseStatus('chargeback')).toBe('abstained');
    expect(chargebackWorktree.status).toBe('success');
    expect(chargebackWorktree.evidence.map((item) => item.path)).toContain('src/payments/payment.service.ts');

    const arbitration = (await executeCodebaseSearch({ query: 'arbitration dispute' }, scope)).result;
    expect(arbitration.status).toBe('success');
    expect(arbitration.evidence.map((item) => item.path)).toContain('src/disputes/dispute.service.ts');

    const ledgerWorktree = (await executeCodebaseSearch({ query: 'ledger totals' }, scope)).result;
    expect(await baseStatus('ledger totals')).toBe('success');
    expect(ledgerWorktree.status).toBe('abstained');
  });

  it('hides an uncommitted edit of the main checkout from a worktree that does not have it', async () => {
    const scope = await scopeFor(linked);

    expect(await baseStatus('impersonation')).toBe('success');
    expect((await executeCodebaseSearch({ query: 'impersonation' }, scope)).result.status).toBe('abstained');
  });

  it('never changes the base index', async () => {
    const before = baseFingerprint(dbPath);
    const scope = await scopeFor(linked);
    await executeCodebaseSearch({ query: 'chargeback' }, scope);
    await executeCodebaseSearch({ query: 'reconcileLedgerTotals' }, scope);

    expect(baseFingerprint(dbPath)).toEqual(before);
    expect(before.trigger).toBe(true);
  });

  it('reports provenance, reuses the base vectors of unchanged chunks, and embeds nothing on a repeat', async () => {
    const worktree = await views.resolve(linked);
    const first = await views.read(worktree, { embed: true }, () => 'ok');
    expect(first.worktree).toMatchObject({ path: linked, branch: 'feature', isPinnedRoot: false, deletedFiles: 1 });
    // payment.service.ts edited, dispute.service.ts added, user.service.ts restored to its commit.
    expect(first.worktree.changedFiles).toBe(3);
    expect(first.worktree.chunksReused).toBeGreaterThan(0);
    expect(first.worktree.chunksEmbedded).toBeGreaterThan(0);
    expect(first.window.windowOutlivedMacrotask).toBe(false);

    const documentsBefore = embeddings.documents;
    const second = await views.read(worktree, { embed: true }, () => 'ok');
    expect(embeddings.documents).toBe(documentsBefore);
    expect(second.worktree).toMatchObject({ changedFiles: 3, chunksEmbedded: 0 });
    expect(second.worktree.chunksReused).toBe(first.worktree.chunksReused + first.worktree.chunksEmbedded);
  });

  it('runs a search inside one macrotask once its query embedding is known', async () => {
    const worktree = await views.resolve(linked);
    const search = (scopeRead: WorktreeIndexScope['read']) => executeCodebaseSearch({ query: 'chargeback' }, { read: scopeRead });
    let lastWindow: { windowOutlivedMacrotask: boolean; attempts: number } | undefined;
    const scopeRead: WorktreeIndexScope['read'] = async (read) => {
      const outcome = await views.read(worktree, { embed: true }, read);
      lastWindow = outcome.window;
      return outcome;
    };

    await search(scopeRead);
    expect(lastWindow?.attempts).toBe(2);
    await search(scopeRead);
    expect(lastWindow).toMatchObject({ attempts: 1, windowOutlivedMacrotask: false });
  });

  it('serves the dependency graph of the worktree without embedding anything', async () => {
    const worktree = await views.resolve(linked);
    const documentsBefore = embeddings.documents;

    const baseInbound = executeDependencyGraph({ filePath: 'src/disputes/dispute.service.ts', direction: 'inbound' });
    const { result } = await views.read(worktree, { embed: false }, (view) =>
      executeDependencyGraph({ filePath: 'src/disputes/dispute.service.ts', direction: 'inbound' }, { db: view.db }));

    expect(baseInbound.status).toBe('empty');
    expect(result.data.relations.map((relation) => relation.path)).toContain('src/payments/payment.service.ts');
    expect(embeddings.documents).toBe(documentsBefore);
  });

  it('keeps the overlay invisible to every other connection while it is stacked', async () => {
    const worktree = await views.resolve(linked);
    const seen = await views.read(worktree, { embed: true }, (view) => {
      const inside = view.db.prepare("SELECT COUNT(*) AS total FROM code_chunks WHERE file_path = 'src/disputes/dispute.service.ts'").get() as { total: number };
      const outside = AgentDB.getInstance().prepare("SELECT COUNT(*) AS total FROM code_chunks WHERE file_path = 'src/disputes/dispute.service.ts'").get() as { total: number };
      return { inside: inside.total, outside: outside.total };
    });

    expect(seen.result.inside).toBeGreaterThan(0);
    expect(seen.result.outside).toBe(0);
  });

  it('rolls back when the read throws', async () => {
    const before = baseFingerprint(dbPath);
    const worktree = await views.resolve(linked);

    await expect(views.read(worktree, { embed: true }, () => {
      throw new Error('read failed');
    })).rejects.toThrow('read failed');
    expect(baseFingerprint(dbPath)).toEqual(before);
  });

  it('reports busy, retryably, when a peer holds the write lock', async () => {
    const worktree = await views.resolve(linked);
    const delta = await views.delta(worktree);
    const overlay = { worktree, delta, files: [], embedded: true, stats: { chunks: 0, reused: 0, embedded: 0, buildMs: 0 } };
    const scope = new OverlayScope({ dbPath, embeddings, busyTimeoutMs: 50 });
    const peer = new Database(dbPath);
    peer.exec('BEGIN IMMEDIATE');
    try {
      await expect(scope.run(overlay, () => 'never')).rejects.toBeInstanceOf(OverlayBusyError);
    } finally {
      peer.exec('ROLLBACK');
      peer.close();
      scope.close();
    }
  });

  it('describes the main checkout itself as indexed plus its own uncommitted changes', async () => {
    const worktree = await views.resolve(repo);
    expect(worktree.isPinnedRoot).toBe(true);
    const delta = await views.delta(worktree);
    // The edit to user.service.ts was indexed, so the checkout matches its index.
    expect(delta.changed).toEqual([]);
    expect(delta.deleted).toEqual([]);
  });
});

describe('WorktreeViewService on a superproject with a submodule', () => {
  let base: string;
  let superproject: string;
  let submoduleWorktree: string;
  let embeddings: ReturnType<typeof countingEmbeddings>;
  let views: WorktreeViewService;

  beforeEach(async () => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-submodule-view-')));
    const library = path.join(base, 'library');
    fs.mkdirSync(path.join(library, 'src'), { recursive: true });
    fs.writeFileSync(path.join(library, 'src', 'quote.service.ts'), [
      '/** Prices insurance quotes. */',
      'export class QuoteService {',
      '  /** Computes a premium. */',
      '  premium(age: number): number {',
      '    return age * 2;',
      '  }',
      '}',
      '',
    ].join('\n'));
    git(library, 'init', '-q', '-b', 'main');
    git(library, 'add', '.');
    git(library, 'commit', '-q', '-m', 'library');

    superproject = path.join(base, 'superproject');
    fs.mkdirSync(superproject);
    fs.writeFileSync(path.join(superproject, 'package.json'), '{"name":"superproject"}');
    fs.writeFileSync(path.join(superproject, 'tsconfig.json'), '{"include":["**/src/**/*.ts"]}');
    fs.writeFileSync(path.join(superproject, '.gitignore'), '.umbra/\n.claude/\n.worktrees/\n');
    git(superproject, 'init', '-q', '-b', 'main');
    git(superproject, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', library, 'libs/quotes');
    git(superproject, 'add', '.');
    git(superproject, 'commit', '-q', '-m', 'superproject');

    pinRuntimeRoot(superproject);
    IndexerService.silent = true;
    embeddings = countingEmbeddings();
    await new IndexerService(embeddings).indexProject();
    loadVectorExtensionInto(AgentDB.getInstance());

    // A worktree of the submodule, placed where the superproject keeps them.
    submoduleWorktree = path.join(superproject, '.worktrees', 'quotes-feature');
    git(path.join(superproject, 'libs/quotes'), 'worktree', 'add', '-q', '-b', 'feature', submoduleWorktree);
    fs.writeFileSync(path.join(submoduleWorktree, 'src', 'quote.service.ts'), [
      '/** Prices insurance quotes. */',
      'export class QuoteService {',
      '  /** Computes a premium. */',
      '  premium(age: number): number {',
      '    return age * 2;',
      '  }',
      '',
      '  /** Applies an underwriting surcharge for smokers. */',
      '  surcharge(smoker: boolean): number {',
      '    return smoker ? 1.5 : 1;',
      '  }',
      '}',
      '',
    ].join('\n'));

    resetWorktreeDeltaCache();
    views = new WorktreeViewService({
      pinnedRoot: superproject,
      baseDb: AgentDB.getInstance(),
      dbPath: agentPath(superproject, 'memory.db'),
      embeddings,
      isIndexing: () => IndexerService.running,
    });
  });

  afterEach(() => {
    views.close();
    AgentDB.close();
    resetRuntimeRoot();
    IndexerService.silent = false;
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('selects a worktree of a submodule, which the superproject\'s own worktree list never shows', async () => {
    const worktree = await views.resolve(path.join(submoduleWorktree, 'src'));
    expect(worktree).toMatchObject({ root: submoduleWorktree, indexPrefix: 'libs/quotes', isPinnedRoot: false, branch: 'feature' });
  });

  it('selects the submodule\'s own checkout, which git lists only by its gitdir', async () => {
    const checkout = path.join(superproject, 'libs/quotes');
    await expect(views.resolve(path.join(checkout, 'src'))).resolves.toMatchObject({
      root: checkout, repositoryRoot: checkout, indexPrefix: 'libs/quotes', isPinnedRoot: false,
    });
  });

  it('answers in the index\'s paths, with the submodule worktree\'s content', async () => {
    const worktree = await views.resolve(submoduleWorktree);
    const scope: WorktreeIndexScope = { read: (read) => views.read(worktree, { embed: true }, read) };

    expect((await new GraphRagService(new RetrieverService(embeddings)).search('underwriting surcharge smokers')).status).toBe('abstained');
    const answer = (await executeCodebaseSearch({ query: 'underwriting surcharge smokers' }, scope)).result;
    expect(answer.status).toBe('success');
    expect(answer.evidence.map((item) => item.path)).toContain('libs/quotes/src/quote.service.ts');
    expect(answer.worktree).toMatchObject({ indexPrefix: 'libs/quotes', changedFiles: 1, deletedFiles: 0 });
  });
});
