import { McpSdk, McpServerLike } from './sdk-loader';
import { PublishedPrompt } from './prompt-catalog';
import { PublishedResource } from './resource-catalog';
import { PublishedTool } from './tool-catalog';

/**
 * Builds an `McpServer` from Umbra's catalogs.
 *
 * ## What the SDK now owns, and what stays ours
 *
 * The SDK owns the **protocol**: JSON-RPC framing, request ids, notifications,
 * error codes, capability advertisement, the `initialize` handshake, and the
 * JSON Schema it derives from the zod shapes. Roughly 400 lines of that used to
 * live in this directory and are gone.
 *
 * What stays ours is everything the SDK cannot know:
 *
 * - **The DTO boundary.** Umbra's tools return `❌ DENIED: …` and
 *   `💡 AGENT HINT: … run: read_file("…")`, written for Umbra's own system
 *   prompt. `dto-mapper.ts` translates the refusals and strips the hints. A
 *   protocol library has no opinion about that, and it is the law this project
 *   applies at every other presentation layer.
 * - **Which tools exist at all.** `ask_codebase` is registered only when
 *   embeddings can answer, because the published list is fixed at launch and
 *   telling a foreign model about a tool that fails on first use is the ADR-013
 *   defect.
 * - **Descriptions rewritten for a foreign reader**, provenance on retrieval
 *   answers, and the resource catalog.
 *
 * ## What is deliberately not enabled
 *
 * No `sampling`: it would let this server spend the client's model budget on a
 * prompt nobody audited. No dynamic tool list: `sendToolListChanged` exists on
 * the SDK server and is not called, because a list that changes under a client
 * recreates the prompt/tool drift ADR-013 documents, with an external process
 * as the cause.
 *
 * @example
 * ```ts
 * const server = buildSdkServer(sdk, { version, tools, resources, prompts });
 * await server.connect(new sdk.StdioServerTransport());
 * ```
 */

/** Everything the server publishes. */
export interface SdkServerCatalogs {
  /** Package version, reported in `serverInfo`. */
  version: string;
  /** Guidance a client may show or prepend. */
  instructions?: string;
  tools: readonly PublishedTool[];
  resources: readonly PublishedResource[];
  prompts: readonly PublishedPrompt[];
}

/**
 * Registers every catalog entry on a new `McpServer`.
 *
 * @param sdk - The loaded SDK.
 * @param catalogs - What to publish.
 * @returns A server ready to `connect` to a transport.
 */
export function buildSdkServer(sdk: McpSdk, catalogs: SdkServerCatalogs): McpServerLike {
  const server = new sdk.McpServer(
    { name: 'umbra', version: catalogs.version },
    catalogs.instructions === undefined ? undefined : { instructions: catalogs.instructions },
  );

  for (const tool of catalogs.tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        // Declared so a client can reason about the call without trying it.
        // Every published tool reads; none of them writes, and that is a
        // property of the mode rather than of any one tool (ADR-024,
        // constraint 2).
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      },
      async (args: Record<string, unknown>) => {
        // `invoke` already maps refusals and failures into `isError` results, so
        // a tool that declines is reported to the client as a tool error rather
        // than as a protocol fault. Letting it throw here would surface as a
        // JSON-RPC error, and a client would see the connection misbehave
        // instead of reading the reason.
        const result = await tool.invoke(args ?? {});
        return result;
      },
    );
  }

  for (const resource of catalogs.resources) {
    server.registerResource(
      resource.descriptor.name,
      resource.descriptor.uri,
      {
        description: resource.descriptor.description,
        mimeType: resource.descriptor.mimeType,
      },
      () => ({ contents: [resource.read()] }),
    );
  }

  for (const prompt of catalogs.prompts) {
    server.registerPrompt(
      prompt.descriptor.name,
      { description: prompt.descriptor.description },
      () => prompt.read(),
    );
  }

  return server;
}
