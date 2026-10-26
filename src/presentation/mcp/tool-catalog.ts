import { z } from 'zod';
import {
  adrCatalogResultSchema, codebaseSearchResultSchema, dependencyGraphResultSchema,
  executeCodebaseSearch, executeDependencyGraph, executeGraphRagInvestigation, executeIntegrityCheck, executeListAdrs,
  executeProjectInventory, executeWorkspaceSearch,
  executeNestGraph, integrityResultSchema, nestGraphResultSchema,
  graphRagInvestigationResultSchema,
  indexStatusResultSchema, type IndexStatusResult, workspaceInventoryResultSchema, workspaceSearchResultSchema,
  isRetryableRead, type WorktreeIndexScope,
} from '../../core/tools/read-only-executions';
import { McpToolResult } from './mcp.contracts';
import { toStructuredToolResult } from './dto-mapper';
import { McpConversationService } from './conversation-service';
import { selectWorktree, worktreeArgument } from './worktree-arguments';

/** A read-only capability published to a foreign MCP client. */
export interface PublishedTool {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: z.ZodRawShape;
  readonly outputSchema?: z.ZodType;
  readonly invoke: (args: Record<string, unknown>) => Promise<McpToolResult>;
  readonly rootUnavailable?: (message: string) => McpToolResult;
  /** Per-tool MCP metadata when a read invokes an external model service. */
  readonly annotations?: Record<string, boolean>;
}

/** Publishes a durable, read-only advisor conversation with an opaque receipt. */
function publishConversation(service: McpConversationService, rootDir: () => string | undefined): PublishedTool {
  const schema = z.object({
    conversationId: z.string().uuid(),
    answer: z.string(),
  });
  return {
    name: 'continue_conversation',
    title: 'Continue repository conversation',
    description: 'Starts or continues a read-only repository advisor conversation. Keep the returned conversationId to preserve its checked context across calls.',
    inputSchema: {
      message: z.string().trim().min(1).max(12_000).describe('The next user message.'),
      conversationId: z.string().uuid().optional().describe('Opaque receipt returned by a prior conversation turn.'),
    },
    outputSchema: schema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    invoke: async (args) => {
      const activeRoot = rootDir();
      if (activeRoot === undefined) {
        return { content: [{ type: 'text', text: 'A validated project root is required before a conversation can start.' }], isError: true };
      }
      const input = z.object({ message: z.string().trim().min(1).max(12_000), conversationId: z.string().uuid().optional() }).parse(args);
      const result = await service.continue(activeRoot, input.message, input.conversationId);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: schema.parse(result) };
    },
  };
}

/** Current availability of semantic retrieval without invoking a provider. */
export interface SemanticSearchReadiness {
  readonly ready: boolean;
  readonly message: string;
  /**
   * Whether asking again later is the right response.
   *
   * True only while the index is still warming. A refusal that will not change
   * on its own — no root, a failed warm-up, an index that cannot serve — is not
   * retryable and must keep saying so, because {@link isToolResultError} turns a
   * `blocked` result into an MCP `isError`, and a LangChain-JS client throws a
   * `ToolException` on that instead of letting the model read `nextAction`.
   */
  readonly retryable: boolean;
}

function diagnostic(message: string, code: string) {
  return [{ severity: 'error' as const, code, message }] as const;
}

function publishListAdrs(): PublishedTool {
  const failure = (message: string) => toStructuredToolResult(adrCatalogResultSchema, {
    schemaVersion: 1, status: 'blocked', code: 'ADR_CATALOG_ERROR', summary: 'The ADR catalog is unavailable.',
    data: { catalogStatus: 'cached', generatedAt: '', availableModules: [], entries: [] }, evidence: [],
    diagnostics: diagnostic(message, 'ADR_CATALOG_ERROR'), truncated: false, retryable: false,
  });
  return {
    name: 'list_adrs', title: 'List architecture decisions',
    // Not read-only, and saying otherwise was the problem. A cache miss makes
    // `buildAdrIndex` write `.umbra/adr-index.json` — with or without `refresh`,
    // which is why removing that argument would not have made this true.
    // `readOnlyHint` is exactly the assertion a client uses to skip its own
    // approval gate, so publishing it here claimed something the tool does not
    // honour. The alternative — compute without persisting over MCP — keeps the
    // claim but spends the cache ADR-003/004 exist to keep, on the startup path
    // ADR-024 already records as painful. Declaring the truth costs one prompt.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Lists repository ADR metadata and optional module matches. Returns no ADR bodies.',
    inputSchema: { refresh: z.boolean().optional().describe('Rebuild the cached catalog.'), module: z.string().min(1).optional().describe('Optional discovered ADR module.') },
    outputSchema: adrCatalogResultSchema,
    invoke: async (args) => toStructuredToolResult(adrCatalogResultSchema, executeListAdrs({ refresh: args.refresh === true, ...(typeof args.module === 'string' ? { module: args.module } : {}) })),
    rootUnavailable: failure,
  };
}

function publishDependencyGraph(): PublishedTool {
  const failure = (message: string) => toStructuredToolResult(dependencyGraphResultSchema, {
    schemaVersion: 1, status: 'blocked', code: 'DEPENDENCY_GRAPH_ERROR', summary: 'The dependency graph is unavailable.',
    data: { filePath: '', direction: 'outbound', relations: [] }, evidence: [], diagnostics: diagnostic(message, 'DEPENDENCY_GRAPH_ERROR'), truncated: false, retryable: false,
  });
  return {
    name: 'query_dependency_graph', title: 'Query file dependencies',
    description: 'Finds inbound or outbound TypeScript file dependencies in the authorized project.',
    inputSchema: { filePath: z.string().min(1).describe('Repository-relative TypeScript file path.'), direction: z.enum(['inbound', 'outbound']).describe('Direction of dependency traversal.'), worktree: worktreeArgument },
    outputSchema: dependencyGraphResultSchema,
    invoke: async (args) => {
      const input = z.object({ filePath: z.string().min(1), direction: z.enum(['inbound', 'outbound']), worktree: worktreeArgument }).parse(args);
      const query = { filePath: input.filePath, direction: input.direction };
      if (input.worktree === undefined) return toStructuredToolResult(dependencyGraphResultSchema, executeDependencyGraph(query));
      const selection = await selectWorktree(input.worktree);
      if (!selection.ok) return failure(selection.message);
      try {
        // Graph rows only: edges need no vectors, so no embedding provider is involved.
        const { result, worktree } = await selection.views.read(selection.worktree, { embed: false }, (view) => executeDependencyGraph(query, { db: view.db }));
        return toStructuredToolResult(dependencyGraphResultSchema, { ...result, worktree });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (!isRetryableRead(error)) return failure(message);
        return toStructuredToolResult(dependencyGraphResultSchema, {
          schemaVersion: 1, status: 'abstained', code: 'DEPENDENCY_GRAPH_ERROR', summary: 'The worktree view of the dependency graph is briefly unavailable.',
          data: { filePath: query.filePath, direction: query.direction, relations: [] }, evidence: [],
          diagnostics: [{ severity: 'warning', code: 'WORKTREE_OVERLAY_BUSY', message }], truncated: false, retryable: true,
          nextAction: 'Retry the same call in a moment.',
        });
      }
    },
    rootUnavailable: failure,
  };
}

function publishNestGraph(): PublishedTool {
  const failure = (message: string) => toStructuredToolResult(nestGraphResultSchema, {
    schemaVersion: 1, status: 'blocked', code: 'NEST_GRAPH_ERROR', summary: 'The NestJS graph is unavailable.',
    data: { name: '', normalizedName: '', direction: 'module', bindings: [], injections: [] }, evidence: [], diagnostics: diagnostic(message, 'NEST_GRAPH_ERROR'), truncated: false, retryable: false,
  });
  return {
    name: 'query_nest_graph', title: 'Query NestJS wiring',
    description: 'Finds providers, injection consumers, or module bindings in the authorized project.',
    inputSchema: { name: z.string().trim().min(1).describe('Injection token or module class name.'), direction: z.enum(['provides', 'injects', 'module']).describe('Wiring relationship to inspect.'), worktree: worktreeArgument },
    outputSchema: nestGraphResultSchema,
    invoke: async (args) => {
      const input = z.object({ name: z.string().trim().min(1), direction: z.enum(['provides', 'injects', 'module']), worktree: worktreeArgument }).parse(args);
      const query = { name: input.name, direction: input.direction };
      if (input.worktree === undefined) return toStructuredToolResult(nestGraphResultSchema, executeNestGraph(query));
      const selection = await selectWorktree(input.worktree);
      if (!selection.ok) return failure(selection.message);
      try {
        const { result, worktree } = await selection.views.read(selection.worktree, { embed: false }, (view) => executeNestGraph(query, { db: view.db }));
        return toStructuredToolResult(nestGraphResultSchema, { ...result, worktree });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (!isRetryableRead(error)) return failure(message);
        return toStructuredToolResult(nestGraphResultSchema, {
          schemaVersion: 1, status: 'abstained', code: 'NEST_GRAPH_ERROR', summary: 'The worktree view of the NestJS graph is briefly unavailable.',
          data: { name: query.name, normalizedName: '', direction: query.direction, bindings: [], injections: [] }, evidence: [],
          diagnostics: [{ severity: 'warning', code: 'WORKTREE_OVERLAY_BUSY', message }], truncated: false, retryable: true,
          nextAction: 'Retry the same call in a moment.',
        });
      }
    },
    rootUnavailable: failure,
  };
}

function publishIntegrityCheck(): PublishedTool {
  const failure = (message: string) => toStructuredToolResult(integrityResultSchema, {
    schemaVersion: 1, status: 'blocked', code: 'INTEGRITY_BLOCKED', summary: 'The integrity check is blocked.', data: { projects: [] }, evidence: [], diagnostics: diagnostic(message, 'INTEGRITY_BLOCKED'), truncated: false, retryable: false,
  });
  return {
    name: 'run_integrity_check', title: 'Run TypeScript integrity check',
    description: 'Runs TypeScript no-emit checks. The project root is fixed by the server and cannot be supplied.',
    inputSchema: {}, outputSchema: integrityResultSchema,
    invoke: async () => toStructuredToolResult(integrityResultSchema, await executeIntegrityCheck()), rootUnavailable: failure,
  };
}

function publishAskCodebase(readReadiness: () => SemanticSearchReadiness): PublishedTool {
  const emptyData = { query: '', recoveredWithContext: false, unknownTerms: [], ignoredModifiers: [], droppedTerms: [], files: [] };
  // A warming index is an abstention, not a transport failure. Reported as
  // `blocked` it became `isError: true`, and a LangChain-JS client raises a
  // `ToolException` on that without ever handing the model the `nextAction` —
  // destroying this server's own recovery instruction on the single most common
  // first contact, a cold start. A refusal that will not change on its own stays
  // `blocked`, because there it is the truth.
  const unavailable = (message: string, retryable = false) => toStructuredToolResult(codebaseSearchResultSchema, retryable
    ? {
      schemaVersion: 1, status: 'abstained', code: 'CODEBASE_INDEX_UNAVAILABLE', summary: 'Semantic search is not ready yet.',
      data: emptyData, evidence: [], diagnostics: [], truncated: false, retryable: true,
      nextAction: 'Read get_index_status and retry after durable coverage is ready.',
    }
    : {
      schemaVersion: 1, status: 'blocked', code: 'CODEBASE_INDEX_UNAVAILABLE', summary: 'Semantic search is unavailable.',
      data: emptyData, evidence: [], diagnostics: diagnostic(message, 'CODEBASE_INDEX_UNAVAILABLE'), truncated: false, retryable: false,
      nextAction: 'Read get_index_status and retry after durable coverage is ready.',
    });
  return {
    name: 'ask_codebase', title: 'Search the codebase',
    description: 'Searches indexed code with the approved deterministic hybrid/graph policy and returns paths, ranges, snippets, provenance, and a next read-only recommendation. Scores are ranking signals, not confidence probabilities.',
    inputSchema: { query: z.string().min(1).describe('Original natural-language code question.'), context: z.string().max(2000).optional().describe('Optional one-time clarification.'), worktree: worktreeArgument },
    outputSchema: codebaseSearchResultSchema,
    invoke: async (args) => {
      const input = z.object({ query: z.string().min(1), context: z.string().max(2000).optional(), worktree: worktreeArgument }).parse(args);
      const readiness = readReadiness();
      if (!readiness.ready) return unavailable(readiness.message, readiness.retryable);
      const search = { query: input.query, ...(input.context === undefined ? {} : { context: input.context }) };
      if (input.worktree === undefined) return toStructuredToolResult(codebaseSearchResultSchema, (await executeCodebaseSearch(search)).result);
      const selection = await selectWorktree(input.worktree);
      if (!selection.ok) return unavailable(selection.message);
      const scope: WorktreeIndexScope = { read: (read) => selection.views.read(selection.worktree, { embed: true }, read) };
      return toStructuredToolResult(codebaseSearchResultSchema, (await executeCodebaseSearch(search, scope)).result);
    },
    rootUnavailable: unavailable,
  };
}

/** Publishes a metadata-only map of the pinned workspace's safe artifact types. */
function publishProjectInventory(): PublishedTool {
  const failure = (message: string) => toStructuredToolResult(workspaceInventoryResultSchema, {
    schemaVersion: 1, status: 'error', code: 'WORKSPACE_INVENTORY_ERROR', summary: 'The workspace inventory is unavailable.',
    data: { filesByType: {}, excludedByReason: {} }, evidence: [], diagnostics: diagnostic(message, 'WORKSPACE_INVENTORY_ERROR'), truncated: false, retryable: false,
  });
  return {
    name: 'inspect_project', title: 'Inspect project artifact types',
    description: 'Maps safe project artifact types and exclusions without reading content or requiring an index.',
    inputSchema: { worktree: worktreeArgument }, outputSchema: workspaceInventoryResultSchema,
    invoke: async (args) => {
      const input = z.object({ worktree: worktreeArgument }).parse(args ?? {});
      if (input.worktree === undefined) return toStructuredToolResult(workspaceInventoryResultSchema, executeProjectInventory());
      const startedAt = Date.now();
      const selection = await selectWorktree(input.worktree);
      if (!selection.ok) return failure(selection.message);
      const result = executeProjectInventory(selection.worktree.root);
      return toStructuredToolResult(workspaceInventoryResultSchema, {
        ...result, worktree: selection.provenanceOf(selection.worktree, undefined, { elapsedMs: Date.now() - startedAt }),
      });
    },
    rootUnavailable: failure,
  };
}

/** Publishes bounded literal workspace search without requiring semantic-index coverage. */
function publishWorkspaceSearch(): PublishedTool {
  const failure = (message: string) => toStructuredToolResult(workspaceSearchResultSchema, {
    schemaVersion: 1, status: 'blocked', code: 'WORKSPACE_SEARCH_ERROR', summary: 'The workspace search is blocked.',
    data: { query: '', scannedFiles: 0, matches: [], excludedByReason: {} }, evidence: [], diagnostics: diagnostic(message, 'WORKSPACE_SEARCH_ERROR'), truncated: false, retryable: false,
  });
  return {
    name: 'search_workspace', title: 'Search workspace literally',
    description: 'Finds exact literal text in safe project artifacts, including files outside the semantic index. Results are live matches, not semantic ranking.',
    inputSchema: {
      query: z.string().trim().min(1).max(500).describe('Exact literal text to find.'),
      path: z.string().min(1).optional().describe('Optional repository-relative file or directory.'),
      maxMatches: z.number().int().min(1).max(100).optional().describe('Maximum matches to return; defaults to 100.'),
      worktree: worktreeArgument,
    },
    outputSchema: workspaceSearchResultSchema,
    invoke: async (args) => {
      const input = z.object({ query: z.string().trim().min(1).max(500), path: z.string().min(1).optional(), maxMatches: z.number().int().min(1).max(100).optional(), worktree: worktreeArgument }).parse(args);
      const search = {
        query: input.query,
        ...(input.path === undefined ? {} : { path: input.path }),
        ...(input.maxMatches === undefined ? {} : { maxMatches: input.maxMatches }),
      };
      if (input.worktree === undefined) return toStructuredToolResult(workspaceSearchResultSchema, executeWorkspaceSearch(search));
      const startedAt = Date.now();
      const selection = await selectWorktree(input.worktree);
      if (!selection.ok) return failure(selection.message);
      // A live read: the worktree's own files, under the same containment rules as the served root.
      const result = executeWorkspaceSearch(search, selection.worktree.root);
      return toStructuredToolResult(workspaceSearchResultSchema, {
        ...result, worktree: selection.provenanceOf(selection.worktree, undefined, { elapsedMs: Date.now() - startedAt }),
      });
    },
    rootUnavailable: failure,
  };
}

/** Publishes source-free GraphRAG plan comparison without granting any local configuration write. */
function publishGraphRagInvestigation(readReadiness: () => SemanticSearchReadiness): PublishedTool {
  const emptyData = { runId: '', persisted: false, mode: 'standard' as const, indexFingerprint: '', budget: { maxSeeds: 0, maxDepth: 0, maxNodes: 0, maxRelations: 0, maxChunks: 0, maxEstimatedTokens: 0 }, plans: [] };
  // Same rule as `ask_codebase`: a warming index abstains and says come back; a
  // refusal that will not change on its own is an error. This previously
  // declared `retryable: true` on an `error`, which is a contradiction the
  // client cannot act on — the error is raised before the flag is ever read.
  const unavailable = (message: string, retryable = false) => toStructuredToolResult(graphRagInvestigationResultSchema, retryable
    ? {
      schemaVersion: 1, status: 'abstained', code: 'GRAPHRAG_INVESTIGATION_ERROR', summary: 'GraphRAG comparison is not ready yet.',
      data: emptyData, evidence: [], diagnostics: [], truncated: false, retryable: true,
      nextAction: 'Read get_index_status and retry after durable coverage is ready.',
    }
    : {
      schemaVersion: 1, status: 'error', code: 'GRAPHRAG_INVESTIGATION_ERROR', summary: 'GraphRAG comparison is unavailable.',
      data: emptyData, evidence: [], diagnostics: diagnostic(message, 'GRAPHRAG_INVESTIGATION_ERROR'), truncated: false, retryable: false,
    });
  return {
    name: 'investigate_graphrag', title: 'Compare GraphRAG retrieval plans',
    description: 'Compares deterministic bounded hybrid, dependency, and NestJS retrieval plans from one shared semantic seed lookup. Returns source-free paths, graph routes, budgets, timing, stop receipts, and recommendations; it does not persist a Detective trace, call a chat model, or change configuration.',
    inputSchema: {
      query: z.string().min(1).describe('Original natural-language code question.'),
      mode: z.enum(['standard', 'deep']).optional().describe('Use deep only for a bounded local experiment.'),
    },
    outputSchema: graphRagInvestigationResultSchema,
    invoke: async (args) => {
      const input = z.object({ query: z.string().min(1), mode: z.enum(['standard', 'deep']).optional() }).parse(args);
      const readiness = readReadiness();
      if (!readiness.ready) return unavailable(readiness.message, readiness.retryable);
      return toStructuredToolResult(graphRagInvestigationResultSchema, await executeGraphRagInvestigation(input));
    },
    rootUnavailable: unavailable,
  };
}

/** Assembles the stable MCP catalog. */
export function buildToolCatalog(options: {
  semanticSearchReadiness: () => SemanticSearchReadiness;
  readIndexStatus: () => IndexStatusResult;
  decorateSemanticAnswer?: (text: string) => string;
  projectRootReady?: () => boolean;
  projectRootMessage?: () => string;
  readProjectRoot?: () => string | undefined;
  conversationService?: McpConversationService;
}): PublishedTool[] {
  const catalog: PublishedTool[] = [publishAskCodebase(options.semanticSearchReadiness), publishWorkspaceSearch(), publishProjectInventory(), publishGraphRagInvestigation(options.semanticSearchReadiness), {
    name: 'get_index_status', title: 'Get index status', description: 'Reports live lifecycle, persisted provenance, and durable coverage as separate fields without invoking an embedding provider. With worktree, also reports how many indexed files that worktree changes or lacks.', inputSchema: { worktree: worktreeArgument }, outputSchema: indexStatusResultSchema,
    invoke: async (args) => {
      const input = z.object({ worktree: worktreeArgument }).parse(args ?? {});
      const status = options.readIndexStatus();
      // Before a root is accepted there is no repository to select a worktree of.
      if (input.worktree === undefined || status.code === 'INDEX_STATUS_AWAITING_ROOT') return toStructuredToolResult(indexStatusResultSchema, status);
      const startedAt = Date.now();
      const selection = await selectWorktree(input.worktree);
      if (!selection.ok) {
        return toStructuredToolResult(indexStatusResultSchema, {
          ...status, status: 'blocked', code: 'INDEX_STATUS_ERROR', summary: 'The requested worktree cannot be selected.',
          diagnostics: [{ severity: 'error', code: 'WORKTREE_NOT_SELECTABLE', message: selection.message }, ...status.diagnostics],
        });
      }
      try {
        const delta = await selection.views.delta(selection.worktree);
        return toStructuredToolResult(indexStatusResultSchema, {
          ...status, worktree: selection.provenanceOf(selection.worktree, delta, { elapsedMs: Date.now() - startedAt }),
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toStructuredToolResult(indexStatusResultSchema, {
          ...status, status: 'error', code: 'INDEX_STATUS_ERROR', summary: 'The worktree delta could not be computed.',
          diagnostics: [{ severity: 'error', code: 'WORKTREE_DELTA_ERROR', message }, ...status.diagnostics],
        });
      }
    },
  }, publishListAdrs(), publishDependencyGraph(), publishNestGraph(), publishIntegrityCheck()];
  if (options.projectRootReady === undefined) return catalog;
  const rooted = catalog.map((tool) => tool.name === 'get_index_status' ? tool : { ...tool, invoke: async (args: Record<string, unknown>) => options.projectRootReady?.() ? tool.invoke(args) : tool.rootUnavailable?.(options.projectRootMessage?.() ?? 'No validated project root is available') ?? tool.invoke(args) });
  return options.conversationService === undefined
    ? rooted
    : [...rooted, publishConversation(options.conversationService, options.readProjectRoot ?? (() => undefined))];
}
