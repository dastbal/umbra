import { buildToolCatalog } from './tool-catalog';

describe('MCP ask_codebase catalog', () => {
  it('keeps query compatible and publishes optional contextual retry input', () => {
    const tool = buildToolCatalog({ semanticSearchAvailable: true })
      .find((candidate) => candidate.name === 'ask_codebase');

    expect(tool).toBeDefined();
    expect(tool?.inputSchema.query).toBeDefined();
    expect(tool?.inputSchema.context).toBeDefined();
  });

  it('does not publish retrieval when embeddings are unavailable', () => {
    const names = buildToolCatalog({ semanticSearchAvailable: false }).map((tool) => tool.name);

    expect(names).not.toContain('ask_codebase');
  });
});
