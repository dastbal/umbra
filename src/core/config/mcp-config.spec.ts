import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { buildUmbraMcpServer, ensureUmbraMcpConfiguration } from './mcp-config';

describe('ensureUmbraMcpConfiguration', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-mcp-config-'));
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('creates a pinned Umbra stdio entry when no configuration exists', () => {
    const result = ensureUmbraMcpConfiguration(rootDir);

    expect(result.status).toBe('created');
    expect(JSON.parse(fs.readFileSync(result.path, 'utf8'))).toEqual({
      mcpServers: {
        umbra: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@dastbal/umbra', 'mcp', '--root', rootDir],
        },
      },
    });
  });

  it('builds a client-neutral stdio definition with an absolute pinned root', () => {
    expect(buildUmbraMcpServer(path.join(rootDir, '..', path.basename(rootDir)))).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@dastbal/umbra', 'mcp', '--root', rootDir],
    });
  });

  it('preserves existing servers while adding Umbra', () => {
    const configPath = path.join(rootDir, '.mcp.json');
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { existing: { command: 'tool' } } }));

    const result = ensureUmbraMcpConfiguration(rootDir);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { mcpServers: Record<string, unknown> };

    expect(result.status).toBe('created');
    expect(config.mcpServers.existing).toEqual({ command: 'tool' });
    expect(config.mcpServers.umbra).toEqual(expect.objectContaining({ command: 'npx' }));
  });

  it('updates only a stale Umbra entry and is idempotent afterwards', () => {
    const configPath = path.join(rootDir, '.mcp.json');
    fs.writeFileSync(configPath, JSON.stringify({
      mcpServers: { umbra: { command: 'umbra', args: ['mcp'] }, existing: { command: 'tool' } },
    }));

    expect(ensureUmbraMcpConfiguration(rootDir).status).toBe('updated');
    expect(ensureUmbraMcpConfiguration(rootDir).status).toBe('unchanged');
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).mcpServers.existing).toEqual({ command: 'tool' });
  });

  it('refuses malformed JSON without overwriting it', () => {
    const configPath = path.join(rootDir, '.mcp.json');
    fs.writeFileSync(configPath, '{not json', 'utf8');

    expect(() => ensureUmbraMcpConfiguration(rootDir)).toThrow(/invalid JSON/);
    expect(fs.readFileSync(configPath, 'utf8')).toBe('{not json');
  });

  it('refuses a non-object mcpServers value without overwriting it', () => {
    const configPath = path.join(rootDir, '.mcp.json');
    const original = JSON.stringify({ mcpServers: [] });
    fs.writeFileSync(configPath, original, 'utf8');

    expect(() => ensureUmbraMcpConfiguration(rootDir)).toThrow(/mcpServers/);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(original);
  });
});
