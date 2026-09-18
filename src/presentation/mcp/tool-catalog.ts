import { z } from 'zod';
import {
  adrCatalogResultSchema, codebaseSearchResultSchema, dependencyGraphResultSchema,
  executeCodebaseSearch, executeDependencyGraph, executeGraphRagInvestigation, executeIntegrityCheck, executeListAdrs,
  executeProjectInventory, executeWorkspaceSearch,
  executeNestGraph, integrityResultSchema, nestGraphResultSchema,
  graphRagInvestigationResultSchema,
  indexStatusResultSchema, type IndexStatusResult, workspaceInventoryResultSchema, workspaceSearchResultSchema,
} from '../../core/tools';
import { McpToolResult } from './mcp.contracts';
import { toStructuredToolResult } from './dto-mapper';
import { McpConversationService } from './conversation-service';

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
export interface SemanticSearchReadiness { readonly ready: boolean; readonly message: string; }

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
    inputSchema: { filePath: z.string().min(1).describe('Repository-relative TypeScript file path.'), direction: z.enum(['inbound', 'outbound']).describe('Direction of dependency traversal.') },
    outputSchema: dependencyGraphResultSchema,
    invoke: async (args) => { const input = z.object({ filePath: z.string().min(1), direction: z.enum(['inbound', 'outbound']) }).parse(args); return toStructuredToolResult(dependencyGraphResultSchema, executeDependencyGraph(input)); },
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
    inputSchema: { name: z.string().trim().min(1).describe('Injection token or module class name.'), direction: z.enum(['provides', 'injects', 'module']).describe('Wiring relationship to inspect.') },
    outputSchema: nestGraphResultSchema,
    invoke: async (args) => { const input = z.object({ name: z.string().trim().min(1), direction: z.enum(['provides', 'injects', 'module']) }).parse(args); return toStructuredToolResult(nestGraphResultSchema, executeNestGraph(input)); },
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
  const unavailable = (message: string) => toStructuredToolResult(codebaseSearchResultSchema, {
    schemaVersion: 1, status: 'blocked', code: 'CODEBASE_INDEX_UNAVAILABLE', summary: 'Semantic search is unavailable.',
    data: { query: '', recoveredWithContext: false, unknownTerms: [], ignoredModifiers: [], droppedTerms: [], files: [] }, evidence: [], diagnostics: diagnostic(message, 'CODEBASE_INDEX_UNAVAILABLE'), truncated: false, retryable: false,
    nextAction: 'Read get_index_status and retry after durable coverage is ready.',
  });
  return {
    name: 'ask_codebase', title: 'Search the codebase',
    description: 'Searches indexed code with the approved deterministic hybrid/graph policy and returns paths, ranges, snippets, provenance, and a next read-only recommendation. Scores are ranking signals, not confidence probabilities.',
    inputSchema: { query: z.string().min(1).describe('Original natural-language code question.'), context: z.string().max(2000).optional().describe('Optional one-time clarification.') },
    outputSchema: codebaseSearchResultSchema,
    invoke: async (args) => { const input = z.object({ query: z.string().min(1), context: z.string().max(2000).optional() }).parse(args); const readiness = readReadiness(); if (!readiness.ready) return unavailable(readiness.message); return toStructuredToolResult(codebaseSearchResultSchema, (await executeCodebaseSearch(input)).result); },
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
    inputSchema: {}, outputSchema: workspaceInventoryResultSchema,
    invoke: async () => toStructuredToolResult(workspaceInventoryResultSchema, executeProjectInventory()), rootUnavailable: failure,
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
    },
    outputSchema: workspaceSearchResultSchema,
    invoke: async (args) => {
      const input = z.object({ query: z.string().trim().min(1).max(500), path: z.string().min(1).optional(), maxMatches: z.number().int().min(1).max(100).optional() }).parse(args);
      return toStructuredToolResult(workspaceSearchResultSchema, executeWorkspaceSearch(input));
    },
    rootUnavailable: failure,
  };
}

/** Publishes source-free GraphRAG plan comparison without granting any local configuration write. */
function publishGraphRagInvestigation(readReadiness: () => SemanticSearchReadiness): PublishedTool {
  const unavailable = (message: string) => toStructuredToolResult(graphRagInvestigationResultSchema, {
    schemaVersion: 1, status: 'error', code: 'GRAPHRAG_INVESTIGATION_ERROR', summary: 'GraphRAG comparison is unavailable.',
    data: { runId: '', persisted: false, mode: 'standard', indexFingerprint: '', budget: { maxSeeds: 0, maxDepth: 0, maxNodes: 0, maxRelations: 0, maxChunks: 0, maxEstimatedTokens: 0 }, plans: [] },
    evidence: [], diagnostics: diagnostic(message, 'GRAPHRAG_INVESTIGATION_ERROR'), truncated: false, retryable: true,
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
      if (!readiness.ready) return unavailable(readiness.message);
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
    name: 'get_index_status', title: 'Get index status', description: 'Reports live lifecycle, persisted provenance, and durable coverage as separate fields without invoking an embedding provider.', inputSchema: {}, outputSchema: indexStatusResultSchema,
    invoke: async () => toStructuredToolResult(indexStatusResultSchema, options.readIndexStatus()),
  }, publishListAdrs(), publishDependencyGraph(), publishNestGraph(), publishIntegrityCheck()];
  if (options.projectRootReady === undefined) return catalog;
  const rooted = catalog.map((tool) => tool.name === 'get_index_status' ? tool : { ...tool, invoke: async (args: Record<string, unknown>) => options.projectRootReady?.() ? tool.invoke(args) : tool.rootUnavailable?.(options.projectRootMessage?.() ?? 'No validated project root is available') ?? tool.invoke(args) });
  return options.conversationService === undefined
    ? rooted
    : [...rooted, publishConversation(options.conversationService, options.readProjectRoot ?? (() => undefined))];
}
