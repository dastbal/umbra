import { PassThrough, Writable } from 'stream';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';
import { buildSdkServer } from './sdk-server';
import { loadMcpSdk } from './sdk-loader';
import { PublishedTool } from './tool-catalog';
import { createToolResultSchema } from '../../core/tools/tool-result';
import { toStructuredToolResult } from './dto-mapper';
import { log } from '../../core/tools/utils/logger';
import { resetLogSink, setLogSink } from '../../core/observability/console-sink';
import { pinRuntimeRoot, resetRuntimeRoot } from '../../core/config/runtime-root';
import { buildToolCatalog } from './tool-catalog';
import type { IndexStatusResult } from '../../core/tools';

/**
 * Collects everything written to a fake stdout, line by line.
 *
 * Modelled on `ResponseDouble` in `ai-agent-http.module.spec.ts`: a hand-written
 * stream double rather than a mocking framework, so what is asserted is exactly
 * what would reach the wire.
 */
class StdoutDouble extends Writable {
  public readonly writes: string[] = [];

  public _write(chunk: Buffer | string, _encoding: string, callback: () => void): void {
    this.writes.push(chunk.toString());
    callback();
  }

  /** Non-empty lines written so far. */
  public get lines(): string[] {
    return this.writes.join('').split('\n').filter((line) => line.trim().length > 0);
  }
}

/**
 * Speaks JSON-RPC to a server over injected streams and returns what stdout saw.
 *
 * `StdioServerTransport` takes `(stdin, stdout)`, which is what makes this
 * assertable without spawning a process.
 *
 * @param tools - Tools to publish.
 * @param requests - Raw lines to send.
 * @returns The stdout double after the exchange.
 */
async function exchange(
  tools: readonly PublishedTool[],
  requests: unknown[],
): Promise<StdoutDouble> {
  const load = loadMcpSdk();
  if (!load.available) throw new Error(`SDK unavailable: ${load.reason}`);

  const input = new PassThrough();
  const output = new StdoutDouble();

  const server = buildSdkServer(load.sdk, {
    version: '9.9.9',
    tools,
    resources: [],
    prompts: [],
  });

  await server.connect(new load.sdk.StdioServerTransport(input, output) as never);

  for (const request of requests) {
    input.write(`${typeof request === 'string' ? request : JSON.stringify(request)}\n`);
  }

  // The transport parses on the stream's own tick; one macrotask is enough for
  // the local, synchronous handlers used here.
  await new Promise((resolve) => setTimeout(resolve, 50));

  await server.close();
  input.end();

  return output;
}

/** A stub tool that records what it received. */
function stubTool(overrides: Partial<PublishedTool> = {}): PublishedTool {
  return {
    name: 'list_adrs',
    title: 'List architecture decisions',
    description: 'stub',
    inputSchema: { refresh: z.boolean().optional() },
    invoke: async () => ({ content: [{ type: 'text', text: 'catalog' }] }),
    ...overrides,
  };
}

const handshake = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'spec', version: '0' },
  },
};

describe('MCP server built on the official SDK', () => {
  afterEach(() => {
    resetLogSink();
  });

  it('completes a handshake and advertises the registered tool', async () => {
    const output = await exchange(
      [stubTool()],
      [handshake, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }],
    );

    const listed = output.lines
      .map((line) => JSON.parse(line))
      .find((message) => message.id === 2);

    expect(listed.result.tools.map((t: { name: string }) => t.name)).toEqual(['list_adrs']);
  });

  it('derives the JSON Schema from the zod shape, so there is one contract', async () => {
    // The hand-written inputSchema objects this replaced were a second
    // description of the same contract, maintained by hand, free to drift.
    const output = await exchange(
      [stubTool({ inputSchema: { query: z.string().describe('a question') } })],
      [handshake, { jsonrpc: '2.0', id: 2, method: 'tools/list' }],
    );

    const listed = output.lines
      .map((line) => JSON.parse(line))
      .find((message) => message.id === 2);

    const schema = listed.result.tools[0].inputSchema;
    expect(schema.type).toBe('object');
    expect(schema.properties.query.description).toBe('a question');
    expect(schema.required).toEqual(['query']);
  });

  it('declares every published tool read-only', async () => {
    // A property of the mode, not of any one tool: writes are technically
    // unavailable here because there is no approval channel (ADR-024,
    // constraint 2).
    const output = await exchange([stubTool()], [handshake, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]);

    const listed = output.lines
      .map((line) => JSON.parse(line))
      .find((message) => message.id === 2);

    expect(listed.result.tools[0].annotations.readOnlyHint).toBe(true);
    expect(listed.result.tools[0].annotations.destructiveHint).toBe(false);
  });

  it('never advertises sampling', async () => {
    // Sampling would let this server spend the client's model budget on a
    // prompt nobody audited.
    const output = await exchange([stubTool()], [handshake]);

    const initialized = output.lines
      .map((line) => JSON.parse(line))
      .find((message) => message.id === 1);

    expect(initialized.result.capabilities).not.toHaveProperty('sampling');
  });

  it('reports a tool refusal as a tool error, not a protocol error', async () => {
    const output = await exchange(
      [
        stubTool({
          invoke: async () => ({
            content: [{ type: 'text', text: 'Refused: read-only' }],
            isError: true,
          }),
        }),
      ],
      [handshake, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_adrs', arguments: {} } }],
    );

    const called = output.lines
      .map((line) => JSON.parse(line))
      .find((message) => message.id === 2);

    // The call was valid; the work declined. A client should show the reason to
    // its model rather than see the connection fault.
    expect(called.error).toBeUndefined();
    expect(called.result.isError).toBe(true);
    expect(called.result.content[0].text).toContain('read-only');
  });

  it('reports request-bound liveness only when the caller supplies a progress token', async () => {
    const output = await exchange(
      [stubTool()],
      [
        handshake,
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'list_adrs',
            arguments: {},
            _meta: { progressToken: 'umbra-progress-1' },
          },
        },
      ],
    );

    const messages = output.lines.map((line) => JSON.parse(line));
    const progress = messages.find((message) => message.method === 'notifications/progress');
    const completed = messages.find((message) => message.id === 2);

    expect(progress).toMatchObject({
      jsonrpc: '2.0',
      params: {
        progressToken: 'umbra-progress-1',
        progress: 0,
        message: 'Umbra started List architecture decisions.',
      },
    });
    expect(messages.indexOf(progress)).toBeLessThan(messages.indexOf(completed));
    expect(completed.error).toBeUndefined();
  });

  it('does not emit a progress notification without a caller token', async () => {
    const output = await exchange(
      [stubTool()],
      [handshake, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_adrs', arguments: {} } }],
    );

    const messages = output.lines.map((line) => JSON.parse(line));

    expect(messages.some((message) => message.method === 'notifications/progress')).toBe(false);
  });

  it('advertises and validates a complete typed result through stdio', async () => {
    // This is deliberately a full Umbra result schema rather than a raw output
    // shape. The SDK must serialize it in tools/list and validate the matching
    // structuredContent during tools/call; otherwise a catalog can look healthy
    // while every real tool fails before it executes.
    const resultSchema = createToolResultSchema(
      z.enum(['ADR_CATALOG_READY', 'ADR_CATALOG_ERROR']),
      z.object({ entries: z.array(z.string()) }),
    );
    const result = {
      schemaVersion: 1 as const,
      status: 'success' as const,
      code: 'ADR_CATALOG_READY',
      summary: 'One architecture decision is available.',
      data: { entries: ['ADR-001'] },
      evidence: [],
      diagnostics: [],
      truncated: false,
      retryable: false,
    };
    const output = await exchange(
      [stubTool({
        outputSchema: resultSchema,
        invoke: async () => toStructuredToolResult(resultSchema, result),
      })],
      [
        handshake,
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_adrs', arguments: {} } },
      ],
    );

    const messages = output.lines.map((line) => JSON.parse(line));
    const listed = messages.find((message) => message.id === 2);
    const called = messages.find((message) => message.id === 3);

    expect(listed.result.tools[0].outputSchema.type).toBe('object');
    expect(called.error).toBeUndefined();
    expect(called.result.structuredContent).toEqual(result);
    expect(JSON.parse(called.result.content[0].text)).toEqual(result);
  });

  /**
   * The regression the whole log redirection exists for.
   *
   * `stdout` carries JSON-RPC. Every published tool calls `log.*` on the way to
   * its answer, and `indexer.ts` once wrote a raw `.` per batch while warming
   * the index at launch. One such byte corrupts the connection before the
   * handshake completes, silently from the client's side. Two real leaks were
   * found by this assertion and by nothing else.
   *
   * Kept unchanged from the hand-written transport it replaced: if the SDK
   * speaks the same protocol, the same assertion has to hold.
   */
  it('keeps stdout pure while a tool logs diagnostics', async () => {
    const diagnostics: string[] = [];
    setLogSink((line) => diagnostics.push(line));

    const output = await exchange(
      [
        stubTool({
          invoke: async () => {
            log.tool('Querying codebase: "anything"');
            log.debug('ask_codebase called');
            log.error('something went wrong');
            return { content: [{ type: 'text', text: 'ok' }] };
          },
        }),
      ],
      [handshake, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_adrs', arguments: {} } }],
    );

    expect(output.lines.length).toBeGreaterThan(0);
    for (const line of output.lines) {
      expect(JSON.parse(line).jsonrpc).toBe('2.0');
    }

    // The diagnostics were not lost — they went to the redirected sink.
    expect(diagnostics).toHaveLength(3);
  });
});

describe('MCP SDK loader', () => {
  it('reports availability rather than throwing', () => {
    const load = loadMcpSdk();

    expect(load.available).toBe(true);
  });

  it('names the Umbra reinstall command when its required SDK cannot load', () => {
    // Exercised through the shape rather than by uninstalling the package: the
    // contract that matters is that the reason and the fix travel together.
    const { MCP_SDK_INSTALL_HINT } = require('./sdk-loader') as {
      MCP_SDK_INSTALL_HINT: string;
    };

    expect(MCP_SDK_INSTALL_HINT).toContain('npm i @dastbal/umbra');
    expect(MCP_SDK_INSTALL_HINT).not.toContain('@modelcontextprotocol/sdk');
  });
});

describe('MCP ADR catalog integration', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-mcp-adrs-'));
    fs.mkdirSync(path.join(rootDir, 'docs', 'adr'), { recursive: true });
    fs.writeFileSync(path.join(rootDir, 'docs', 'adr', 'README.md'), '# Decisions\n', 'utf8');
    fs.writeFileSync(
      path.join(rootDir, 'docs', 'adr', 'ADR-001-boundary.md'),
      '# ADR-001: A real boundary\n\n## Status\n\nAccepted\n\n## Context\n\nThe catalog must be discoverable through MCP.\n',
      'utf8',
    );
    pinRuntimeRoot(rootDir);
  });

  afterEach(() => {
    resetRuntimeRoot();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('returns an on-disk docs/adr record through a real stdio tools/call exchange', async () => {
    const indexStatus: IndexStatusResult = {
      schemaVersion: 1,
      status: 'success',
      code: 'INDEX_STATUS_READY',
      summary: 'ready',
      data: { lifecycle: { phase: 'ready', message: 'ready' } },
      evidence: [],
      diagnostics: [],
      truncated: false,
      retryable: false,
    };
    const tool = buildToolCatalog({
      semanticSearchReadiness: () => ({ ready: true, message: 'ready' }),
      readIndexStatus: () => indexStatus,
    }).find((candidate) => candidate.name === 'list_adrs');

    const output = await exchange(
      tool === undefined ? [] : [tool],
      [handshake, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_adrs', arguments: {} } }],
    );
    const response = output.lines.map((line) => JSON.parse(line)).find((message) => message.id === 2);

    expect(response.error).toBeUndefined();
    expect(response.result.structuredContent).toMatchObject({
      status: 'success',
      code: 'ADR_CATALOG_READY',
      data: { entries: [expect.objectContaining({ path: 'docs/adr/ADR-001-boundary.md' })] },
    });
  });
});
