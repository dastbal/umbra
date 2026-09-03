import {
  JSONRPC_VERSION,
  JsonRpcErrorCodes,
  JsonRpcRequest,
  JsonRpcResponse,
  MCP_PROTOCOL_VERSION,
  McpInitializeResult,
  McpServerCapabilities,
} from './mcp.contracts';
import { PublishedTool } from './tool-catalog';
import { PublishedResource } from './resource-catalog';
import { PublishedPrompt } from './prompt-catalog';
import { toErrorResult } from './dto-mapper';

/**
 * Umbra's MCP server: a third presentation adapter beside `cli/` and `http/`.
 *
 * ## What it is not
 *
 * There is **no model inside it**. It does not reason, does not build prompts,
 * does not call a provider, and runs no agent loop. It receives a request and
 * answers by executing deterministic code. Everything ADR-006, ADR-015,
 * ADR-016 and ADR-019 govern — streaming, provider auth, reasoning vocabulary,
 * turn budget — is out of scope here by construction, not by omission.
 *
 * The one place a model is touched at all is the embedding call inside
 * `ask_codebase`, and that tool is only published when embeddings are actually
 * available.
 *
 * ## The domain does not move
 *
 * This class holds no business logic. It dispatches JSON-RPC methods onto
 * catalogs that wrap existing tools. That is the whole point of the decision:
 * reuse the sound half of the codebase without touching it.
 *
 * @example
 * ```ts
 * const server = new UmbraMcpServer({ name: 'umbra', version: '2.1.4', tools, resources, prompts });
 * await new JsonRpcStdioTransport().listen((request) => server.handle(request));
 * ```
 */
export class UmbraMcpServer {
  private readonly tools: Map<string, PublishedTool>;

  private readonly resources: Map<string, PublishedResource>;

  private readonly prompts: Map<string, PublishedPrompt>;

  /**
   * @param options - Server identity and the catalogs it publishes.
   */
  constructor(
    private readonly options: {
      name: string;
      version: string;
      instructions?: string;
      tools: readonly PublishedTool[];
      resources: readonly PublishedResource[];
      prompts: readonly PublishedPrompt[];
    },
  ) {
    this.tools = new Map(options.tools.map((tool) => [tool.descriptor.name, tool]));
    this.resources = new Map(
      options.resources.map((resource) => [resource.descriptor.uri, resource]),
    );
    this.prompts = new Map(options.prompts.map((prompt) => [prompt.descriptor.name, prompt]));
  }

  /**
   * Answers one JSON-RPC request.
   *
   * @param request - A well-formed request or notification.
   * @returns The response, or `undefined` for a notification.
   */
  public async handle(request: JsonRpcRequest): Promise<JsonRpcResponse | undefined> {
    // Notifications carry no id and must never be answered. `initialized` is
    // the one every client sends after the handshake.
    if (request.id === undefined) return undefined;

    const id = request.id;
    const params = request.params ?? {};

    switch (request.method) {
      case 'initialize':
        return this.success(id, this.initialize());

      case 'ping':
        // An empty result is the whole contract. Clients use it as a liveness
        // check and discard the body.
        return this.success(id, {});

      case 'tools/list':
        return this.success(id, {
          tools: this.options.tools.map((tool) => tool.descriptor),
        });

      case 'tools/call':
        return this.success(id, await this.callTool(params));

      case 'resources/list':
        return this.success(id, {
          resources: this.options.resources.map((resource) => resource.descriptor),
        });

      case 'resources/read':
        return this.readResource(id, params);

      case 'prompts/list':
        return this.success(id, {
          prompts: this.options.prompts.map((prompt) => prompt.descriptor),
        });

      case 'prompts/get':
        return this.getPrompt(id, params);

      default:
        return {
          jsonrpc: JSONRPC_VERSION,
          id,
          error: {
            code: JsonRpcErrorCodes.methodNotFound,
            message: `Method "${request.method}" is not supported by this server.`,
          },
        };
    }
  }

  /**
   * Builds the handshake result.
   *
   * The advertised protocol version is this server's own, not the client's
   * requested one. Echoing back whatever a client asks for is how a server ends
   * up claiming support for a revision it has never implemented.
   *
   * @returns The `initialize` result.
   */
  private initialize(): McpInitializeResult {
    const capabilities: McpServerCapabilities = {
      tools: {},
      resources: {},
      prompts: {},
    };

    return {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities,
      serverInfo: { name: this.options.name, version: this.options.version },
      instructions: this.options.instructions,
    };
  }

  /**
   * Executes a published tool.
   *
   * A tool that throws is reported as a tool error rather than a protocol
   * error: the call was valid, the work failed, and a client should be able to
   * show the reason to its model instead of seeing the connection fault.
   *
   * @param params - The `tools/call` params.
   * @returns The tool result.
   */
  private async callTool(params: Record<string, unknown>): Promise<unknown> {
    const name = params.name;

    if (typeof name !== 'string') {
      return toErrorResult('tools/call requires a string "name".');
    }

    const tool = this.tools.get(name);
    if (tool === undefined) {
      const published = [...this.tools.keys()].join(', ');
      return toErrorResult(
        `Unknown tool "${name}". This server publishes: ${published || '(none)'}.`,
      );
    }

    const args =
      typeof params.arguments === 'object' && params.arguments !== null
        ? (params.arguments as Record<string, unknown>)
        : {};

    try {
      return await tool.invoke(args);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return toErrorResult(`${name} failed: ${message}`);
    }
  }

  /**
   * Reads one resource.
   *
   * @param id - The request id.
   * @param params - The `resources/read` params.
   * @returns The response.
   */
  private readResource(
    id: NonNullable<JsonRpcRequest['id']>,
    params: Record<string, unknown>,
  ): JsonRpcResponse {
    const uri = params.uri;

    if (typeof uri !== 'string') {
      return this.invalidParams(id, 'resources/read requires a string "uri".');
    }

    const resource = this.resources.get(uri);
    if (resource === undefined) {
      return this.invalidParams(id, `Unknown resource "${uri}".`);
    }

    try {
      return this.success(id, { contents: [resource.read()] });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return this.invalidParams(id, `Could not read "${uri}": ${message}`);
    }
  }

  /**
   * Returns one prompt.
   *
   * @param id - The request id.
   * @param params - The `prompts/get` params.
   * @returns The response.
   */
  private getPrompt(
    id: NonNullable<JsonRpcRequest['id']>,
    params: Record<string, unknown>,
  ): JsonRpcResponse {
    const name = params.name;

    if (typeof name !== 'string') {
      return this.invalidParams(id, 'prompts/get requires a string "name".');
    }

    const prompt = this.prompts.get(name);
    if (prompt === undefined) {
      return this.invalidParams(id, `Unknown prompt "${name}".`);
    }

    try {
      return this.success(id, prompt.read());
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return this.invalidParams(id, `Could not read prompt "${name}": ${message}`);
    }
  }

  /**
   * Wraps a result as a JSON-RPC success.
   *
   * @param id - The request id.
   * @param result - The payload.
   * @returns The response.
   */
  private success(id: NonNullable<JsonRpcRequest['id']>, result: unknown): JsonRpcResponse {
    return { jsonrpc: JSONRPC_VERSION, id, result };
  }

  /**
   * Builds an `invalidParams` failure.
   *
   * @param id - The request id.
   * @param message - What was wrong with the parameters.
   * @returns The response.
   */
  private invalidParams(
    id: NonNullable<JsonRpcRequest['id']>,
    message: string,
  ): JsonRpcResponse {
    return {
      jsonrpc: JSONRPC_VERSION,
      id,
      error: { code: JsonRpcErrorCodes.invalidParams, message },
    };
  }
}
