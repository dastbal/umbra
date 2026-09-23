import { pinRuntimeRoot, runtimeRoot } from '../../core/config/runtime-root';
import { setLogSink } from '../../core/observability/console-sink';
// Types only — erased at compile time, so they cost nothing at startup. The
// implementations are loaded by `loadIndexingModules` below, after the
// handshake. See its TSDoc for the measurement that moved them.
type AvailabilityModule = typeof import('../../core/rag/embeddings/embeddings-availability');
type ResolverModule = typeof import('../../core/rag/embeddings/embeddings-resolver');
type IndexerModule = typeof import('../../core/rag/indexer');
import {
  formatIndexIntegrity,
  inspectIndexIntegrity,
  inspectIndexServeability,
} from '../../core/rag/index-integrity';
import { readIndexStamp } from '../../core/rag/index-stamp';
import { executeIndexStatus, formatIndexStatusForModel } from '../../core/tools/read-only-executions';
// (the indexer's implementation is loaded lazily; see loadIndexingModules)
import { withProvenance } from './dto-mapper';
import { buildPromptCatalog } from './prompt-catalog';
import { McpConversationService } from './conversation-service';
import {
  activateMcpProjectRoot,
  McpProjectRoot,
  resolveMcpProjectRootFromUris,
} from './project-root';
import { buildResourceCatalog } from './resource-catalog';
import { loadMcpSdk, McpServerLike } from './sdk-loader';
import { buildSdkServer } from './sdk-server';
import { buildToolCatalog, SemanticSearchReadiness } from './tool-catalog';

/** The indexing and embedding modules, resolved once on first use. */
interface IndexingModules {
  readonly availability: AvailabilityModule;
  readonly resolver: ResolverModule;
  readonly indexer: IndexerModule;
}

let indexingModules: IndexingModules | undefined;

/**
 * Loads the indexing and embedding implementations, which a handshake never
 * needs.
 *
 * Measured on this repository: `require`ing `indexer.js` costs **2,923 ms**, of
 * which **2,492 ms** is `embeddings-resolver.js` pulling in the provider SDKs.
 * All of it was paid at module load — before `server.connect`, and therefore
 * inside the window a client's connect timeout measures. It was paid even under
 * `--no-index`, where the indexer is never constructed at all.
 *
 * That matters because the ordering was already deliberate: the transport
 * connects before provider probing and index work, so the handshake is not
 * blocked by them. An eager import defeated that on its own, silently, from the
 * import block.
 *
 * This is the reasoning `sdk-loader` already records for the SDK's HTTP stack —
 * load only what is actually used, so a global server does not fail before its
 * handshake. Every consumer of these symbols runs after the transport is
 * connected: provider selection, the availability probe, the index run, and the
 * status description a client asks for on demand.
 *
 * @returns The warm-up's dependencies, loaded on first call and reused after.
 */
function loadIndexingModules(): IndexingModules {
  if (indexingModules !== undefined) return indexingModules;

  /* eslint-disable @typescript-eslint/no-var-requires */
  indexingModules = {
    availability: require('../../core/rag/embeddings/embeddings-availability') as AvailabilityModule,
    resolver: require('../../core/rag/embeddings/embeddings-resolver') as ResolverModule,
    indexer: require('../../core/rag/indexer') as IndexerModule,
  };
  /* eslint-enable @typescript-eslint/no-var-requires */

  return indexingModules;
}

/** Lifecycle stages visible while an MCP project root and index are warming. */
type McpIndexPhase =
  | 'awaiting-root'
  | 'starting'
  | 'probing'
  | 'indexing'
  | 'ready'
  | 'unavailable'
  | 'failed'
  | 'skipped';

/** In-memory truth about the current process; durable coverage still lives in SQLite. */
interface McpIndexLifecycle {
  phase: McpIndexPhase;
  message: string;
  startedAt?: number;
}

/** Options for {@link startMcpServer}. */
export interface StartMcpServerOptions {
  /** Repository to serve when the launcher already has a trusted project context. */
  root?: string;
  /** When true and `root` is absent, request exactly one MCP client root after handshake. */
  awaitMcpRoot?: boolean;
  /** Package version, reported in `serverInfo`. */
  version: string;
  /** Embedding provider override, e.g. from `--embeddings`. */
  embeddings?: string;
  /** When true, a pre-existing index may be served but no warm-up starts. */
  skipIndex?: boolean;
}

/**
 * Starts the read-only MCP server over stdio.
 *
 * The protocol connection is established before provider probing or indexing.
 * A slow local model can therefore never consume the client's MCP startup
 * window. When a globally configured client cannot give Umbra a trustworthy
 * working directory, the transport still connects and Umbra asks it for one
 * unambiguous MCP `file:` root before creating `.umbra` or touching SQLite.
 */
export async function startMcpServer(options: StartMcpServerOptions): Promise<void> {
  // stdout belongs to JSON-RPC from this line onward.
  setLogSink((line) => process.stderr.write(`${line}\n`));

  const load = loadMcpSdk();
  if (!load.available) {
    report(`cannot start: ${load.reason}`);
    process.stderr.write(`\n${load.instruction}\n`);
    throw new Error('The MCP server requires @modelcontextprotocol/sdk.');
  }

  let rootDir: string | undefined;
  const lifecycle: McpIndexLifecycle = options.root === undefined
    ? {
      phase: 'awaiting-root',
      message: options.awaitMcpRoot === true
        ? 'Waiting for one validated MCP project root.'
        : 'No validated project root was supplied.',
    }
    : { phase: 'starting', message: 'MCP connected; preparing the semantic index.' };

  if (options.root !== undefined) {
    rootDir = activatePinnedRoot({ rootDir: options.root, source: 'working-directory' });
  }

  const tools = buildToolCatalog({
    semanticSearchReadiness: () => semanticSearchReadiness(rootDir, lifecycle),
    readIndexStatus: () => executeIndexStatus(rootDir, lifecycle),
    decorateSemanticAnswer: (text) => decorateSemanticAnswer(rootDir, text),
    projectRootReady: () => rootDir !== undefined,
    projectRootMessage: () => lifecycle.message,
    readProjectRoot: () => rootDir,
    conversationService: new McpConversationService(),
  });
  const server = buildSdkServer(load.sdk, {
    version: options.version,
    instructions:
      'Umbra publishes read-only knowledge about one repository. Its index may be warming in the ' +
      'background; call get_index_status before retrying ask_codebase. The repository is fixed for ' +
      'this session and cannot be changed by a tool argument.',
    tools,
    resources: buildResourceCatalog(() => rootDir, () => formatIndexStatusForModel(executeIndexStatus(rootDir, lifecycle))),
    prompts: buildPromptCatalog(),
  });

  if (rootDir === undefined) {
    wireClientRootResolution(server, options, lifecycle, (resolved) => {
      rootDir = resolved;
    });
    report('umbra mcp — connected without a project root; waiting for client roots.');
  } else {
    report(`umbra mcp — serving ${rootDir}`);
  }
  report(`publishing ${tools.length} tools: ${tools.map((tool) => tool.name).join(', ')}`);

  // This is intentionally before provider probing and index work.
  await server.connect(new load.sdk.StdioServerTransport());
  await server.sendLoggingMessage({
    level: 'notice',
    logger: 'umbra.mcp',
    data: rootDir === undefined
      ? 'Umbra connected and is waiting for a validated project root.'
      : 'Umbra connected; semantic-index warm-up continues in the background.',
  });
  report('MCP transport connected; index warm-up continues in the background.');

  if (rootDir !== undefined) {
    void warmIndexInBackground(rootDir, options, lifecycle);
  }

  await new Promise<void>((resolve) => {
    process.stdin.once('end', () => resolve());
    process.stdin.once('close', () => resolve());
    process.stdin.once('error', () => resolve());
  });

  await server.close();
  report('client disconnected');
}

/** Pins one accepted root, protects it with gitignore, and reports activation. */
function activatePinnedRoot(root: McpProjectRoot): string {
  pinRuntimeRoot(root.rootDir);
  const rootDir = runtimeRoot();
  const activation = activateMcpProjectRoot({ ...root, rootDir });
  if (activation.addedIgnoreRules.length > 0) {
    report(`added local-state ignore rules: ${activation.addedIgnoreRules.join(', ')}`);
  }
  return rootDir;
}

/** Requests an MCP root only after the client has completed its initialization handshake. */
function wireClientRootResolution(
  server: McpServerLike,
  options: StartMcpServerOptions,
  lifecycle: McpIndexLifecycle,
  setRoot: (rootDir: string) => void,
): void {
  let requested = false;
  server.server.oninitialized = () => {
    if (requested) return;
    requested = true;
    void resolveClientRoot(server, options, lifecycle, setRoot);
  };
}

/** Validates one client root before any state or provider activity begins. */
async function resolveClientRoot(
  server: McpServerLike,
  options: StartMcpServerOptions,
  lifecycle: McpIndexLifecycle,
  setRoot: (rootDir: string) => void,
): Promise<void> {
  if (options.awaitMcpRoot !== true) {
    lifecycle.phase = 'failed';
    lifecycle.message = 'No validated project root was supplied. Open one project and reconnect.';
    report(lifecycle.message);
    return;
  }

  try {
    const response = await server.server.listRoots();
    const root = resolveMcpProjectRootFromUris(response.roots.map((candidate) => candidate.uri));
    const rootDir = activatePinnedRoot(root);
    setRoot(rootDir);
    lifecycle.phase = 'starting';
    lifecycle.message = 'Validated MCP project root; preparing the semantic index.';
    report(`validated MCP root — serving ${rootDir}`);
    void warmIndexInBackground(rootDir, options, lifecycle);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    lifecycle.phase = 'failed';
    lifecycle.message = `Could not validate an MCP project root: ${message}`;
    report(lifecycle.message);
  }
}

/** Starts provider probing and indexing without delaying the MCP handshake. */
async function warmIndexInBackground(
  rootDir: string,
  options: StartMcpServerOptions,
  lifecycle: McpIndexLifecycle,
): Promise<void> {
  lifecycle.phase = 'probing';
  lifecycle.message = 'Checking the configured embedding provider.';
  lifecycle.startedAt = Date.now();

  // First touch of the provider SDKs and the indexer, and the whole reason they
  // are not in the import block. This runs after `server.connect`.
  const { probeEmbeddings } = loadIndexingModules().availability;
  const { pinEmbeddingsProvider, resolveEmbeddings } = loadIndexingModules().resolver;
  const { IndexerService } = loadIndexingModules().indexer;

  try {
    const selection = resolveEmbeddings(options.embeddings);
    pinEmbeddingsProvider(selection.port.identity.provider);
    const identity = selection.port.identity;
    report(`embeddings: ${identity.provider}/${identity.model} (from ${selection.source})`);

    if (selection.ignoredValue !== undefined) {
      report(
        `Ignoring unknown embeddings provider "${selection.ignoredValue}". Valid values: vertex, ollama.`,
      );
    }

    const availability = await probeEmbeddings(selection.port);
    if (!availability.available) {
      lifecycle.phase = 'unavailable';
      lifecycle.message = availability.reason ?? 'The embedding provider is unavailable.';
      report(`semantic search unavailable — ${lifecycle.message}`);
      return;
    }

    if (options.skipIndex === true) {
      const ready = hasDurableCoverage(rootDir, identity.provider, identity.model);
      lifecycle.phase = ready ? 'ready' : 'skipped';
      lifecycle.message = ready
        ? 'Serving existing durable vector coverage; automatic warm-up was skipped.'
        : 'Index warm-up was skipped and no durable vector coverage exists.';
      report(lifecycle.message);
      return;
    }

    lifecycle.phase = 'indexing';
    lifecycle.message = `Indexing with ${identity.provider}/${identity.model}.`;
    IndexerService.silent = false;
    const result = await new IndexerService(selection.port, (progress) => {
      lifecycle.message = progress;
    }).indexProject();

    if (result.disposition === 'already-running') {
      lifecycle.phase = 'indexing';
      lifecycle.message = 'Another Umbra process owns this root index lease; waiting for its durable coverage.';
      report(lifecycle.message);
      return;
    }

    if (hasDurableCoverage(rootDir, identity.provider, identity.model)) {
      lifecycle.phase = 'ready';
      lifecycle.message = `Durable vector coverage is ready for ${identity.provider}/${identity.model}.`;
      report('index ready');
      return;
    }

    lifecycle.phase = 'failed';
    lifecycle.message = 'Indexing ended without complete durable vector coverage. Run umbra doctor --index.';
    report(lifecycle.message);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    lifecycle.phase = 'failed';
    lifecycle.message = `Index warm-up failed: ${message}`;
    report(lifecycle.message);
  } finally {
    IndexerService.silent = false;
  }
}

/**
 * Phases in which the refusal is temporary and asking again is the right move.
 *
 * Everything else — `failed`, `unavailable`, `skipped`, or a `ready` phase whose
 * index still cannot serve — needs an operator, not another call.
 */
const WARMING_PHASES: ReadonlySet<McpIndexPhase> = new Set<McpIndexPhase>([
  'awaiting-root', 'starting', 'probing', 'indexing',
]);

/** Builds the availability response used by the stable semantic-search tool. */
function semanticSearchReadiness(
  rootDir: string | undefined,
  lifecycle: McpIndexLifecycle,
): SemanticSearchReadiness {
  // Whether the caller should come back is decided per phase, never by one
  // predicate over "is it unavailable" — a warming index and a failed warm-up
  // are both unavailable, and only one of them is worth retrying.
  const retryable = WARMING_PHASES.has(lifecycle.phase);

  if (rootDir === undefined) return { ready: false, message: lifecycle.message, retryable };
  if (lifecycle.phase !== 'ready') return { ready: false, message: lifecycle.message, retryable };

  const stamp = readIndexStamp(rootDir);
  if (stamp === undefined) return { ready: false, message: 'No durable index stamp exists yet.', retryable: false };

  // Serveability, not integrity. This runs on every `ask_codebase` call, and the
  // full inspection cost 202 ms of a 293 ms round trip to re-derive facts about
  // the filesystem — while the search itself is 2 to 5 ms. The two conjuncts it
  // drops answer *is the index current?*; this gate needs *can the index
  // answer?*. A file edited since the last run used to refuse the question
  // outright, in the middle of a refactor; it now answers, and the reply already
  // carries `indexedAt` so the caller can judge the age. Completeness is still
  // checked wherever it is asked for — `get_index_status`, `umbra doctor
  // --index`, and the boot-time coverage check below all run the full report.
  const serveability = inspectIndexServeability(rootDir, {
    provider: stamp.provider,
    model: stamp.model,
  });
  return serveability.serveable
    ? { ready: true, message: lifecycle.message, retryable: false }
    : {
      ready: false,
      retryable: false,
      message:
        `${serveability.reason ?? 'The index cannot serve a search.'} ` +
        'Read get_index_status, or run umbra doctor --index.',
    };
}

/** Tests persisted coverage without invoking an embedding provider. */
function hasDurableCoverage(rootDir: string, provider: 'vertex' | 'ollama', model: string): boolean {
  return inspectIndexIntegrity(rootDir, { provider, model }).healthy;
}

/** Renders the shared MCP resource/tool view of live and durable index state. */
function describeIndexStatus(rootDir: string | undefined, lifecycle: McpIndexLifecycle): string {
  const lines = [
    `state:         ${lifecycle.phase}`,
    `message:       ${lifecycle.message}`,
    `root:          ${rootDir ?? 'not yet validated'}`,
  ];
  if (lifecycle.startedAt !== undefined) {
    lines.push(`started at:    ${new Date(lifecycle.startedAt).toISOString()}`);
  }
  if (rootDir === undefined) return lines.join('\n');

  const stamp = readIndexStamp(rootDir);
  if (stamp !== undefined) {
    lines.push(
      `provider:      ${stamp.provider}`,
      `model:         ${stamp.model}`,
      `stamp status:  ${stamp.status}`,
      `files indexed: ${stamp.filesIndexed}`,
    );
    lines.push('', formatIndexIntegrity(inspectIndexIntegrity(rootDir, {
      provider: stamp.provider,
      model: stamp.model,
    })));
  } else {
    lines.push('', formatIndexIntegrity(inspectIndexIntegrity(rootDir)));
  }

  return lines.join('\n');
}

/** Adds provenance only after the readiness boundary has allowed a real search. */
function decorateSemanticAnswer(rootDir: string | undefined, text: string): string {
  if (rootDir === undefined) return text;
  const current = readIndexStamp(rootDir);
  // Reached only once a search has been allowed, which means the warm-up has
  // already loaded this module and the call is a memoized lookup.
  const active = loadIndexingModules().resolver.resolveEmbeddings().port.identity;
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
}

/** Writes one operator-facing line to stderr. */
function report(message: string): void {
  process.stderr.write(`[umbra mcp] ${message}\n`);
}
