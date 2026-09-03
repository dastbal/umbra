import { pinRuntimeRoot, runtimeRoot } from '../../core/config/runtime-root';
import { setLogSink } from '../../core/observability/console-sink';
import { probeEmbeddings } from '../../core/rag/embeddings/embeddings-availability';
import {
  pinEmbeddingsProvider,
  resolveEmbeddings,
} from '../../core/rag/embeddings/embeddings-resolver';
import { readIndexStamp } from '../../core/rag/index-stamp';
import { IndexerService } from '../../core/rag/indexer';
import { withProvenance } from './dto-mapper';
import { JsonRpcStdioTransport } from './jsonrpc-stdio.transport';
import { buildPromptCatalog } from './prompt-catalog';
import { buildResourceCatalog } from './resource-catalog';
import { buildToolCatalog } from './tool-catalog';
import { UmbraMcpServer } from './umbra-mcp-server';

/**
 * Boots the read-only MCP server over stdio.
 *
 * ## The startup order is part of the decision
 *
 * 1. **Redirect diagnostics to `stderr`.** First, before anything else can
 *    print. `stdout` carries JSON-RPC, and one stray byte corrupts the
 *    connection before the handshake completes — silently, from the client's
 *    side (ADR-024, constraint 4).
 * 2. **Pin the root.** Before any subsystem touches the database, because
 *    `AgentDB` caches its connection on first use and fixes the workspace for
 *    the life of the process.
 * 3. **Resolve and probe embeddings.** The tool list is fixed at launch, so
 *    whether `ask_codebase` can answer has to be known now.
 * 4. **Warm the index.** With no index, semantic search returns nothing and
 *    says nothing (constraint 5).
 * 5. **Serve.**
 *
 * @example
 * ```ts
 * await startMcpServer({ root: '/repos/londonuw-payments', version: '2.1.4' });
 * ```
 */

/** Options for {@link startMcpServer}. */
export interface StartMcpServerOptions {
  /** Repository to serve. Pinned; never read from a tool argument. */
  root: string;
  /** Package version, reported in `serverInfo`. */
  version: string;
  /** Embedding provider override, e.g. from `--embeddings`. */
  embeddings?: string;
  /** When true, the index is not warmed at launch. */
  skipIndex?: boolean;
}

/**
 * Starts the server and resolves when the client closes the connection.
 *
 * @param options - Startup options.
 * @returns Nothing, once stdin ends.
 */
export async function startMcpServer(options: StartMcpServerOptions): Promise<void> {
  // 1. stdout belongs to the protocol from this line onward.
  setLogSink((line) => process.stderr.write(`${line}\n`));

  // 2. The root is fixed here and nowhere else.
  pinRuntimeRoot(options.root);
  const rootDir = runtimeRoot();
  report(`umbra mcp — serving ${rootDir}`);

  // 3. Can semantic search actually answer?
  //
  // The provider is pinned before anything can construct a retriever, because
  // `askCodebaseTool` builds its own with no argument. Without the pin, the
  // flag reached the probe and the indexer but not the query: retrieval fell
  // back to the config default and answered from the wrong column while the
  // provenance header named the flag's provider. Verified by a live
  // cross-provider run; the unit tests could not see it, because they inject
  // the port directly and never take the path a launch flag takes.
  const selection = resolveEmbeddings(options.embeddings);
  pinEmbeddingsProvider(selection.port.identity.provider);

  if (selection.ignoredValue !== undefined) {
    report(
      `Ignoring unknown embeddings provider "${selection.ignoredValue}". ` +
        'Valid values: vertex, ollama.',
    );
  }

  const identity = selection.port.identity;
  report(`embeddings: ${identity.provider}/${identity.model} (from ${selection.source})`);

  const availability = await probeEmbeddings(selection.port);

  if (!availability.available) {
    // Not published, and the reason is stated. Advertising a tool that fails on
    // first use is the ADR-013 defect, and here it cannot be corrected
    // mid-session because the list is fixed at launch.
    report(`ask_codebase NOT published — ${availability.reason ?? 'embeddings unavailable'}`);
    report('The other three tools need no credentials and are unaffected.');
  }

  // 4. A cold index answers nothing and says nothing.
  if (availability.available && options.skipIndex !== true) {
    await warmIndex(selection.port);
  } else if (options.skipIndex === true) {
    report('Index warming skipped (--no-index).');
  }

  const stamp = readIndexStamp(rootDir);
  if (stamp?.status === 'partial') {
    report(
      `WARNING: the semantic index is incomplete (${stamp.filesIndexed} files, some failed to ` +
        'embed). Answers will say so.',
    );
  }

  // 5. Serve.
  const tools = buildToolCatalog({
    semanticSearchAvailable: availability.available,
    // Provenance is read at call time from the stamp on disk, and the stamp is
    // written by whoever built the index. It is deliberately NOT taken from the
    // launch-time selection: doing that produced a header naming one provider
    // over an answer computed from another's vectors, which is the one outcome
    // worse than no header at all. If the stamp and the active provider
    // disagree, the header says so rather than picking a side.
    decorateSemanticAnswer: (text) => {
      const current = readIndexStamp(rootDir);
      const active = resolveEmbeddings().port.identity;

      return withProvenance(text, {
        provider: current?.provider ?? active.provider,
        model: current?.model ?? active.model,
        indexedAt: current?.indexedAt,
        filesIndexed: current?.filesIndexed,
        status: current?.status,
        queriedWith:
          current !== undefined && current.provider !== active.provider
            ? `${active.provider}/${active.model}`
            : undefined,
      });
    },
  });

  const server = new UmbraMcpServer({
    name: 'umbra',
    version: options.version,
    instructions:
      'Umbra publishes read-only knowledge about one repository: its ADR catalog, its AST dependency ' +
      'graph, a type-level integrity check, and (when an embedding index is available) semantic code ' +
      'search. It cannot write, run commands, or reach the network. The repository was fixed when this ' +
      'server was launched and cannot be changed by a tool argument.',
    tools,
    resources: buildResourceCatalog(rootDir),
    prompts: buildPromptCatalog(),
  });

  report(`publishing ${tools.length} tools: ${tools.map((t) => t.descriptor.name).join(', ')}`);

  await new JsonRpcStdioTransport().listen((request) => server.handle(request));
  report('client disconnected');
}

/**
 * Warms the semantic index, reporting rather than failing.
 *
 * An index that cannot be built is a degraded server, not a broken one: the
 * three credential-free tools still work. Failing to start would withhold them
 * over a problem they do not have.
 *
 * @param port - The embedding port to index with.
 * @returns Nothing.
 */
async function warmIndex(port: Parameters<typeof probeEmbeddings>[0]): Promise<void> {
  report('warming the semantic index...');

  try {
    // Suppress the indexer's own progress chatter: it is a terminal affordance,
    // and here there is no terminal. The redirected sink already keeps it off
    // stdout; this keeps it out of the client's log as well.
    IndexerService.silent = true;
    await new IndexerService(port).indexProject();
    report('index ready');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    report(`index warming failed: ${message}`);
    report('ask_codebase may return an explicit index error until this is resolved.');
  } finally {
    IndexerService.silent = false;
  }
}

/**
 * Writes one operator-facing line to `stderr`.
 *
 * Deliberately not routed through the log sink: this is the server talking
 * about itself during startup, and it must reach `stderr` even if a future
 * change alters what the sink does.
 *
 * @param message - The line to write.
 * @returns Nothing.
 */
function report(message: string): void {
  process.stderr.write(`[umbra mcp] ${message}\n`);
}
