/**
 * Loads the official MCP SDK, which is an **optional** peer dependency.
 *
 * ## Why optional rather than a plain dependency
 *
 * The SDK is 5.7 MB and pulls in roughly 6.9 MB more — `hono`, `ajv`, `jose`,
 * `express`, `cors`, `eventsource` — seventeen packages, into a library that
 * declares twenty direct dependencies in total. A consumer who installs
 * `@dastbal/umbra` for its NestJS module or its agent factory should not pay
 * 12 MB for a protocol they never speak.
 *
 * `peerDependencies` + `peerDependenciesMeta.optional` rather than
 * `optionalDependencies`, because `optionalDependencies` **installs** and the
 * point is that the consumer chooses.
 *
 * ## Why the SDK at all, after shipping a hand-written transport
 *
 * The hand-written JSON-RPC transport was justified on a premise that turned
 * out to be false — that the SDK was ESM-only and unusable from this CommonJS
 * project. It is not: its `exports` map carries a `require` condition and a
 * full CJS build, the same dual layout `@langchain/core` uses. That was checked
 * by reading `type: "module"` at the top of the manifest and stopping there.
 *
 * With the premise gone, the trade reverses. Owning a protocol implementation
 * means owning every future revision of it, and it forecloses the things the
 * SDK already has: an HTTP/streamable transport for serving several clients,
 * elicitation — the channel ADR-024 named as the prerequisite for anything that
 * writes — progress, and cancellation.
 *
 * @example
 * ```ts
 * const sdk = loadMcpSdk();
 * if (!sdk.available) { process.stderr.write(sdk.instruction); process.exit(1); }
 * ```
 */

/** The pieces of the SDK this adapter uses. */
export interface McpSdk {
  /** `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js`. */
  readonly McpServer: new (info: { name: string; version: string }, options?: unknown) => McpServerLike;
  /** `StdioServerTransport` from `@modelcontextprotocol/sdk/server/stdio.js`. */
  readonly StdioServerTransport: new (
    stdin?: NodeJS.ReadableStream,
    stdout?: NodeJS.WritableStream,
  ) => unknown;
}

/**
 * The subset of `McpServer` this adapter calls.
 *
 * Declared structurally rather than imported as a type, so `src/` compiles and
 * type-checks with the SDK absent. Importing its types would make an optional
 * dependency mandatory at build time, which defeats the point.
 */
export interface McpServerLike {
  registerTool(
    name: string,
    config: {
      title?: string;
      description?: string;
      inputSchema?: unknown;
      annotations?: Record<string, unknown>;
    },
    handler: (args: Record<string, unknown>) => Promise<unknown>,
  ): unknown;

  registerResource(
    name: string,
    uri: string,
    config: { title?: string; description?: string; mimeType?: string },
    handler: (uri: URL) => Promise<unknown> | unknown,
  ): unknown;

  registerPrompt(
    name: string,
    config: { title?: string; description?: string; argsSchema?: unknown },
    handler: () => Promise<unknown> | unknown,
  ): unknown;

  connect(transport: unknown): Promise<void>;

  close(): Promise<void>;
}

/** Outcome of attempting to load the SDK. */
export type McpSdkLoad =
  | { readonly available: true; readonly sdk: McpSdk }
  | { readonly available: false; readonly reason: string; readonly instruction: string };

/** What to tell an operator who does not have the SDK installed. */
export const MCP_SDK_INSTALL_HINT =
  'The MCP server needs @modelcontextprotocol/sdk, which Umbra declares as an optional peer ' +
  'dependency so that consumers who never speak MCP do not download it.\n' +
  '  Local install:  npm i @modelcontextprotocol/sdk\n' +
  '  Global install: npm i -g @dastbal/umbra @modelcontextprotocol/sdk\n';

/**
 * Attempts to load the SDK.
 *
 * Never throws: a missing optional dependency is a fact to report with the
 * command that fixes it, not a stack trace. A degraded mode that does not
 * explain itself is worse than a required dependency.
 *
 * @returns The SDK, or the reason it is unavailable plus how to install it.
 */
export function loadMcpSdk(): McpSdkLoad {
  try {
    // Required lazily and by separate subpaths, because the SDK's root export
    // pulls in its HTTP stack — express, hono — which a stdio server never
    // touches. Loading only `server/mcp.js` and `server/stdio.js` keeps startup
    // to what is actually used.
    /* eslint-disable @typescript-eslint/no-var-requires */
    const mcp = require('@modelcontextprotocol/sdk/server/mcp.js') as {
      McpServer: McpSdk['McpServer'];
    };
    const stdio = require('@modelcontextprotocol/sdk/server/stdio.js') as {
      StdioServerTransport: McpSdk['StdioServerTransport'];
    };
    /* eslint-enable @typescript-eslint/no-var-requires */

    return {
      available: true,
      sdk: { McpServer: mcp.McpServer, StdioServerTransport: stdio.StdioServerTransport },
    };
  } catch (error: unknown) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
      instruction: MCP_SDK_INSTALL_HINT,
    };
  }
}
