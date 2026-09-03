import { PassThrough, Writable } from 'stream';
import { JsonRpcStdioTransport } from './jsonrpc-stdio.transport';
import { JsonRpcRequest, JsonRpcResponse } from './mcp.contracts';
import { log } from '../../core/tools/utils/logger';
import { resetLogSink, setLogSink } from '../../core/observability/console-sink';
import { UmbraMcpServer } from './umbra-mcp-server';

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
 * Drives the transport with a scripted set of lines and returns what stdout saw.
 *
 * @param lines - Raw lines to feed, newline appended automatically.
 * @param handle - The request handler.
 * @returns The stdout double, after the stream has ended.
 */
async function drive(
  lines: string[],
  handle: (request: JsonRpcRequest) => Promise<JsonRpcResponse | undefined>,
): Promise<StdoutDouble> {
  const input = new PassThrough();
  const output = new StdoutDouble();
  const transport = new JsonRpcStdioTransport(input, output);

  const finished = transport.listen(handle);
  for (const line of lines) input.write(`${line}\n`);
  input.end();
  await finished;

  return output;
}

describe('JSON-RPC stdio transport', () => {
  afterEach(() => {
    resetLogSink();
  });

  it('answers a request with a single JSON line', async () => {
    const output = await drive(
      [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })],
      async (request) => ({ jsonrpc: '2.0', id: request.id!, result: {} }),
    );

    expect(output.lines).toHaveLength(1);
    expect(JSON.parse(output.lines[0]!)).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
  });

  it('never answers a notification, which JSON-RPC forbids', async () => {
    const output = await drive(
      [JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })],
      async () => undefined,
    );

    expect(output.lines).toHaveLength(0);
  });

  it('reports malformed JSON as a parse error and stays connected', async () => {
    const output = await drive(
      ['not json at all', JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })],
      async (request) => ({ jsonrpc: '2.0', id: request.id!, result: {} }),
    );

    const [failure, success] = output.lines.map((line) => JSON.parse(line));
    expect(failure.error.code).toBe(-32700);
    expect(failure.id).toBeNull();
    // The connection survived: the next well-formed request was still served.
    expect(success.result).toEqual({});
  });

  it('correlates an invalid-request error with the id it can recover', async () => {
    const output = await drive([JSON.stringify({ jsonrpc: '2.0', id: 7 })], async () => undefined);

    const failure = JSON.parse(output.lines[0]!);
    expect(failure.id).toBe(7);
    expect(failure.error.code).toBe(-32600);
  });

  it('answers rather than hanging when a handler throws', async () => {
    // A handler that throws without a response leaves the client waiting
    // forever on an id that will never come back.
    const output = await drive([JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'boom' })], async () => {
      throw new Error('handler exploded');
    });

    const failure = JSON.parse(output.lines[0]!);
    expect(failure.id).toBe(3);
    expect(failure.error.code).toBe(-32603);
    expect(failure.error.message).toContain('handler exploded');
  });

  it('handles two requests arriving in one chunk, in order', async () => {
    const input = new PassThrough();
    const output = new StdoutDouble();
    const transport = new JsonRpcStdioTransport(input, output);

    const finished = transport.listen(async (request) => ({
      jsonrpc: '2.0',
      id: request.id!,
      result: { method: request.method },
    }));

    input.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'first' })}\n` +
        `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'second' })}\n`,
    );
    input.end();
    await finished;

    expect(output.lines.map((line) => JSON.parse(line).id)).toEqual([1, 2]);
  });

  /**
   * The regression this whole redirection exists for.
   *
   * Under `umbra mcp`, `stdout` carries JSON-RPC. Every published tool calls
   * `log.*` on the way to its answer, and `indexer.ts` used to write a raw `.`
   * to `stdout` per batch while the server warmed the index at launch. One such
   * byte corrupts the connection before the handshake completes, and does so
   * silently from the client's side. No visual review finds that; this does.
   */
  it('keeps stdout pure while a tool logs diagnostics', async () => {
    const stderrLines: string[] = [];
    setLogSink((line) => stderrLines.push(line));

    const output = await drive(
      [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call' })],
      async (request) => {
        log.tool('Querying codebase: "anything"');
        log.debug('ask_codebase called');
        log.error('something went wrong');
        return { jsonrpc: '2.0', id: request.id!, result: { ok: true } };
      },
    );

    // Every line on stdout parses as JSON-RPC 2.0, and only one was written.
    expect(output.lines).toHaveLength(1);
    for (const line of output.lines) {
      expect(JSON.parse(line).jsonrpc).toBe('2.0');
    }
    // The diagnostics were not lost — they went to the redirected sink.
    expect(stderrLines).toHaveLength(3);
  });
});

describe('UmbraMcpServer dispatch', () => {
  /**
   * Builds a server with one stub tool, one resource and one prompt.
   *
   * @returns The server under test.
   */
  function buildServer(): UmbraMcpServer {
    return new UmbraMcpServer({
      name: 'umbra',
      version: '9.9.9',
      tools: [
        {
          descriptor: {
            name: 'list_adrs',
            description: 'stub',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          },
          invoke: async () => ({ content: [{ type: 'text', text: 'catalog' }] }),
        },
      ],
      resources: [
        {
          descriptor: {
            uri: 'umbra://adr-index',
            name: 'stub',
            description: 'stub',
            mimeType: 'text/markdown',
          },
          read: () => ({ uri: 'umbra://adr-index', mimeType: 'text/markdown', text: 'body' }),
        },
      ],
      prompts: [
        {
          descriptor: { name: 'mentor-mode', description: 'stub' },
          read: () => ({
            description: 'stub',
            messages: [{ role: 'user', content: { type: 'text', text: 'guide' } }],
          }),
        },
      ],
    });
  }

  it('advertises tools, resources and prompts — and never sampling or listChanged', async () => {
    const response = await buildServer().handle({ jsonrpc: '2.0', id: 1, method: 'initialize' });

    const result = (response as { result: Record<string, any> }).result;
    expect(Object.keys(result.capabilities).sort()).toEqual(['prompts', 'resources', 'tools']);
    // Sampling would let this server spend the client's model budget on a
    // prompt nobody audited; listChanged would recreate ADR-013's drift.
    expect(result.capabilities).not.toHaveProperty('sampling');
    expect(JSON.stringify(result.capabilities)).not.toContain('listChanged');
  });

  it('advertises its own protocol version rather than echoing the client request', async () => {
    const response = await buildServer().handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '1999-01-01' },
    });

    const result = (response as { result: { protocolVersion: string } }).result;
    expect(result.protocolVersion).not.toBe('1999-01-01');
  });

  it('returns methodNotFound for an unsupported method', async () => {
    const response = await buildServer().handle({ jsonrpc: '2.0', id: 4, method: 'sampling/createMessage' });

    expect((response as { error: { code: number } }).error.code).toBe(-32601);
  });

  it('names what it does publish when an unknown tool is called', async () => {
    const response = await buildServer().handle({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'safe_write_file', arguments: {} },
    });

    const result = (response as { result: { isError: boolean; content: { text: string }[] } }).result;
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('list_adrs');
  });

  it('reports a throwing tool as a tool error, not a protocol error', async () => {
    const server = new UmbraMcpServer({
      name: 'umbra',
      version: '0',
      tools: [
        {
          descriptor: {
            name: 'boom',
            description: 'stub',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          },
          invoke: async () => {
            throw new Error('index unavailable');
          },
        },
      ],
      resources: [],
      prompts: [],
    });

    const response = await server.handle({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'boom', arguments: {} },
    });

    // The call was valid; the work failed. A client should show the reason to
    // its model, not see the connection fault.
    expect(response).not.toHaveProperty('error');
    const result = (response as { result: { isError: boolean; content: { text: string }[] } }).result;
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('index unavailable');
  });

  it('rejects an unknown resource uri', async () => {
    const response = await buildServer().handle({
      jsonrpc: '2.0',
      id: 7,
      method: 'resources/read',
      params: { uri: 'umbra://nope' },
    });

    expect((response as { error: { code: number } }).error.code).toBe(-32602);
  });

  it('returns nothing at all for a notification', async () => {
    const response = await buildServer().handle({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });

    expect(response).toBeUndefined();
  });
});
