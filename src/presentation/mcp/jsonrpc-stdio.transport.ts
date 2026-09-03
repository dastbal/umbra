import { Readable, Writable } from 'stream';
import {
  JSONRPC_VERSION,
  JsonRpcErrorCodes,
  JsonRpcFailure,
  JsonRpcRequest,
  JsonRpcResponse,
} from './mcp.contracts';

/**
 * Newline-delimited JSON-RPC 2.0 over stdio: the wire MCP uses, and the only
 * component in this process permitted to write to `stdout`.
 *
 * ## Why this is hand-written
 *
 * `@modelcontextprotocol/sdk` is the obvious choice and was rejected for two
 * concrete reasons, not a preference:
 *
 * 1. It is `"type": "module"`. This project compiles to CommonJS
 *    (`tsconfig.json`, and `package.json` has no `"type"`), which is also why
 *    `chalk` is pinned to `^4`. The SDK cannot be `require()`d from the built
 *    output.
 * 2. It depends on `express`, `hono`, `jose`, `cors`, `ajv` and `eventsource` —
 *    eighteen transitive packages added to a library that has nineteen direct
 *    dependencies in total, to serve nine methods over a pipe.
 *
 * What is actually required here is a line reader, `JSON.parse`, and a
 * serializer. Owning that is cheaper than owning the packaging problem, and it
 * gives absolute control over `stdout`, which ADR-024 constraint 4 requires.
 *
 * ## The framing
 *
 * One JSON value per line. Blank lines are ignored. A line that does not parse
 * produces a `parseError` **response**, not a crash: a client that sends
 * garbage should be told so and remain connected.
 *
 * @example
 * ```ts
 * const transport = new JsonRpcStdioTransport();
 * transport.listen(async (request) => server.handle(request));
 * ```
 */
export class JsonRpcStdioTransport {
  private buffer = '';

  private closed = false;

  /**
   * @param input - Source of inbound lines; defaults to `process.stdin`.
   * @param output - Destination for responses; defaults to `process.stdout`.
   */
  constructor(
    private readonly input: Readable = process.stdin,
    private readonly output: Writable = process.stdout,
  ) {}

  /**
   * Begins reading requests and answering them.
   *
   * A handler returning `undefined` writes nothing, which is how notifications
   * are honoured: JSON-RPC forbids responding to a message with no `id`.
   *
   * @param handle - Invoked once per well-formed request.
   * @returns A promise that settles when the input stream ends.
   */
  public listen(
    handle: (request: JsonRpcRequest) => Promise<JsonRpcResponse | undefined>,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      this.input.setEncoding('utf-8');

      this.input.on('data', (chunk: string) => {
        this.buffer += chunk;
        void this.drain(handle);
      });

      this.input.on('end', () => {
        this.closed = true;
        resolve();
      });

      // A closed pipe is the normal way a client shuts a stdio server down, not
      // an error to report. Reporting it would write to a stream that is, by
      // definition, no longer being read.
      this.input.on('error', () => {
        this.closed = true;
        resolve();
      });
    });
  }

  /**
   * Consumes every complete line currently buffered.
   *
   * Lines are handled in order and awaited one at a time. Concurrency here
   * would let two responses interleave on the wire, and ordering is cheap to
   * keep: every published tool is a local read.
   *
   * @param handle - The request handler.
   * @returns Nothing.
   */
  private async drain(
    handle: (request: JsonRpcRequest) => Promise<JsonRpcResponse | undefined>,
  ): Promise<void> {
    let newlineIndex = this.buffer.indexOf('\n');

    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      newlineIndex = this.buffer.indexOf('\n');

      if (line.length === 0) continue;

      await this.handleLine(line, handle);
    }
  }

  /**
   * Parses and dispatches one line.
   *
   * @param line - A single trimmed, non-empty line.
   * @param handle - The request handler.
   * @returns Nothing.
   */
  private async handleLine(
    line: string,
    handle: (request: JsonRpcRequest) => Promise<JsonRpcResponse | undefined>,
  ): Promise<void> {
    let parsed: unknown;

    try {
      parsed = JSON.parse(line);
    } catch {
      this.send(this.failure(null, JsonRpcErrorCodes.parseError, 'Invalid JSON.'));
      return;
    }

    if (!isJsonRpcRequest(parsed)) {
      const id = extractId(parsed);
      this.send(
        this.failure(
          id,
          JsonRpcErrorCodes.invalidRequest,
          'Expected a JSON-RPC 2.0 request object with a string "method".',
        ),
      );
      return;
    }

    try {
      const response = await handle(parsed);
      if (response !== undefined) this.send(response);
    } catch (error: unknown) {
      // A handler that throws must still produce a response, or the client
      // waits forever on an id that will never be answered. The message is
      // included because a read-only server has nothing secret to leak, and a
      // silent internal error is undiagnosable from the other end of a pipe.
      const message = error instanceof Error ? error.message : String(error);

      if (parsed.id === undefined) return;
      this.send(this.failure(parsed.id, JsonRpcErrorCodes.internalError, message));
    }
  }

  /**
   * Writes one response as a single line.
   *
   * @param response - The response to serialize.
   * @returns Nothing.
   */
  public send(response: JsonRpcResponse): void {
    if (this.closed) return;
    this.output.write(`${JSON.stringify(response)}\n`);
  }

  /**
   * Builds an error response.
   *
   * @param id - The request id, or `null` when it could not be determined.
   * @param code - A JSON-RPC error code.
   * @param message - Human-readable explanation.
   * @returns The failure response.
   */
  private failure(
    id: JsonRpcFailure['id'],
    code: JsonRpcFailure['error']['code'],
    message: string,
  ): JsonRpcFailure {
    return { jsonrpc: JSONRPC_VERSION, id, error: { code, message } };
  }
}

/**
 * Narrows an arbitrary parsed value to a JSON-RPC request.
 *
 * The `jsonrpc` field is checked but a wrong value is tolerated as long as
 * `method` is present, because rejecting an otherwise valid call over a version
 * tag helps nobody. A missing or non-string `method` is fatal: there is nothing
 * to dispatch on.
 *
 * @param value - A parsed JSON value.
 * @returns Whether it can be dispatched.
 */
function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;

  const candidate = value as Record<string, unknown>;
  if (typeof candidate.method !== 'string') return false;

  const id = candidate.id;
  if (id !== undefined && typeof id !== 'string' && typeof id !== 'number') return false;

  return true;
}

/**
 * Recovers an id from a malformed request so the error can be correlated.
 *
 * @param value - A parsed JSON value.
 * @returns The id, or `null` when absent or unusable.
 */
function extractId(value: unknown): JsonRpcFailure['id'] {
  if (typeof value !== 'object' || value === null) return null;

  const id = (value as Record<string, unknown>).id;
  if (typeof id === 'string' || typeof id === 'number') return id;

  return null;
}
