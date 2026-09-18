import { buildToolCatalog } from './tool-catalog';
import type { IndexStatusResult } from '../../core/tools';

const indexStatus = (phase: 'ready' | 'indexing' | 'unavailable' | 'awaiting-root' = 'ready'): IndexStatusResult => {
  const common = { schemaVersion: 1 as const, summary: `state: ${phase}`, data: { lifecycle: { phase, message: `state: ${phase}` } }, evidence: [], truncated: false, retryable: false };
  return phase === 'awaiting-root'
    ? { ...common, status: 'blocked', code: 'INDEX_STATUS_AWAITING_ROOT', diagnostics: [{ severity: 'error', code: 'INDEX_STATUS_AWAITING_ROOT', message: `state: ${phase}` }] }
    : { ...common, status: 'success', code: 'INDEX_STATUS_READY', diagnostics: [] };
};

describe('MCP ask_codebase catalog', () => {
  it('keeps query compatible and publishes optional contextual retry input', () => {
    const tool = buildToolCatalog({
      semanticSearchReadiness: () => ({ ready: true, message: 'ready' }),
      readIndexStatus: () => indexStatus(),
    })
      .find((candidate) => candidate.name === 'ask_codebase');

    expect(tool).toBeDefined();
    expect(tool?.inputSchema.query).toBeDefined();
    expect(tool?.inputSchema.context).toBeDefined();
  });

  it('keeps a stable catalog and returns a retryable status while indexing', async () => {
    const tools = buildToolCatalog({
      semanticSearchReadiness: () => ({ ready: false, message: 'indexing 23% (12/52 files)' }),
      readIndexStatus: () => indexStatus('indexing'),
    });
    const ask = tools.find((candidate) => candidate.name === 'ask_codebase');
    const names = tools.map((tool) => tool.name);

    expect(names).toContain('ask_codebase');
    expect(names).toContain('get_index_status');
    await expect(ask?.invoke({ query: 'where is this implemented?' })).resolves.toMatchObject({
      content: [{ type: 'text', text: expect.stringContaining('indexing 23%') }],
      isError: true,
      structuredContent: { status: 'blocked', code: 'CODEBASE_INDEX_UNAVAILABLE' },
    });
  });

  it('publishes the same index status through a no-argument tool', async () => {
    const status = buildToolCatalog({
      semanticSearchReadiness: () => ({ ready: false, message: 'provider unavailable' }),
      readIndexStatus: () => indexStatus('unavailable'),
    }).find((candidate) => candidate.name === 'get_index_status');

    await expect(status?.invoke({})).resolves.toMatchObject({
      structuredContent: { data: { lifecycle: { phase: 'unavailable' } } },
    });
  });

  it('keeps the catalog visible but gates root-bound tools until the client supplies a root', async () => {
    const tools = buildToolCatalog({
      semanticSearchReadiness: () => ({ ready: false, message: 'waiting for root' }),
      readIndexStatus: () => indexStatus('awaiting-root'),
      projectRootReady: () => false,
      projectRootMessage: () => 'Open exactly one project and reconnect.',
    });
    const adrs = tools.find((candidate) => candidate.name === 'list_adrs');
    const status = tools.find((candidate) => candidate.name === 'get_index_status');

    await expect(adrs?.invoke({})).resolves.toMatchObject({
      content: [{ type: 'text', text: expect.stringContaining('Open exactly one project') }],
      isError: true,
    });
    await expect(status?.invoke({})).resolves.toMatchObject({
      structuredContent: { status: 'blocked', code: 'INDEX_STATUS_AWAITING_ROOT' },
    });
  });
});

describe('MCP live workspace evidence catalog', () => {
  const catalog = () => buildToolCatalog({
    semanticSearchReadiness: () => ({ ready: true, message: 'ready' }),
    readIndexStatus: () => indexStatus(),
  });

  it('publishes literal search and metadata inventory without requiring semantic readiness', () => {
    const search = catalog().find((candidate) => candidate.name === 'search_workspace');
    const inventory = catalog().find((candidate) => candidate.name === 'inspect_project');

    expect(search?.inputSchema.query).toBeDefined();
    expect(search?.inputSchema.path).toBeDefined();
    expect(search?.description).toContain('not semantic ranking');
    expect(inventory?.inputSchema).toEqual({});
  });

  it('blocks literal search at the same pinned-root boundary as other workspace tools', async () => {
    const search = buildToolCatalog({
      semanticSearchReadiness: () => ({ ready: true, message: 'ready' }),
      readIndexStatus: () => indexStatus(),
      projectRootReady: () => false,
      projectRootMessage: () => 'Open exactly one project and reconnect.',
    }).find((candidate) => candidate.name === 'search_workspace');

    await expect(search?.invoke({ query: 'idempotencyKey' })).resolves.toMatchObject({
      isError: true,
      structuredContent: { status: 'blocked', code: 'WORKSPACE_SEARCH_ERROR' },
    });
  });
});

describe('MCP GraphRAG Detective catalog', () => {
  it('publishes a deterministic, opt-in GraphRAG investigation without a promotion input', () => {
    const tool = buildToolCatalog({
      semanticSearchReadiness: () => ({ ready: true, message: 'ready' }),
      readIndexStatus: () => indexStatus(),
    }).find((candidate) => candidate.name === 'investigate_graphrag');

    expect(tool).toBeDefined();
    expect(tool?.inputSchema.query).toBeDefined();
    expect(tool?.inputSchema.mode).toBeDefined();
    expect(tool?.inputSchema.policy).toBeUndefined();
    expect(tool?.description).toContain('does not persist a Detective trace');
  });

  it('returns a typed retryable refusal while semantic retrieval is unavailable', async () => {
    const tool = buildToolCatalog({
      semanticSearchReadiness: () => ({ ready: false, message: 'indexing 23% (12/52 files)' }),
      readIndexStatus: () => indexStatus('indexing'),
    }).find((candidate) => candidate.name === 'investigate_graphrag');

    await expect(tool?.invoke({ query: 'where is AGENT_TOKEN injected?' })).resolves.toMatchObject({
      isError: true,
      structuredContent: { status: 'error', code: 'GRAPHRAG_INVESTIGATION_ERROR', retryable: true },
    });
  });
});

describe('MCP query_nest_graph', () => {
  const catalog = () =>
    buildToolCatalog({
      semanticSearchReadiness: () => ({ ready: true, message: 'ready' }),
      readIndexStatus: () => indexStatus(),
    });

  it('is published alongside the file-level graph, not instead of it', () => {
    const names = catalog().map((tool) => tool.name);

    expect(names).toContain('query_nest_graph');
    expect(names).toContain('query_dependency_graph');
  });

  it('advertises a token or module name rather than a file path', () => {
    const tool = catalog().find((candidate) => candidate.name === 'query_nest_graph');

    expect(tool?.inputSchema.name).toBeDefined();
    expect(tool?.inputSchema.direction).toBeDefined();
    // A `filePath` here would be a contract a model gets wrong exactly when the
    // token is a string constant that belongs to no file.
    expect(tool?.inputSchema.filePath).toBeUndefined();
  });

  it('rejects an empty name instead of querying for nothing', async () => {
    const tool = catalog().find((candidate) => candidate.name === 'query_nest_graph');

    await expect(tool?.invoke({ name: '   ', direction: 'provides' })).rejects.toBeDefined();
  });

  it('rejects a direction it does not implement', async () => {
    const tool = catalog().find((candidate) => candidate.name === 'query_nest_graph');

    await expect(tool?.invoke({ name: 'AI_AGENT', direction: 'exports' })).rejects.toBeDefined();
  });
});
