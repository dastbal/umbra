import {
  askCodebaseTool,
  integrityCheckTool,
  listAdrsTool,
  queryDependencyGraphTool,
} from '../../core/tools';
import { McpToolDescriptor, McpToolResult } from './mcp.contracts';
import { toErrorResult, toToolResult } from './dto-mapper';

/**
 * The read-only tools Umbra publishes over MCP, and nothing else.
 *
 * ## What is deliberately absent
 *
 * `safeWriteFileTool`, `deleteFileTool`, `executeTestsTool`,
 * `executeCommandTool` and the delegation tools. Not withheld out of caution:
 * writes are **technically unavailable** in this mode. `requestApproval`
 * suspends a run by raising a LangGraph `interrupt()`, which only exists inside
 * a graph run. An MCP server has no graph, therefore no interrupt, therefore no
 * human approval channel — so nothing that writes may be exposed (ADR-024,
 * constraint 2).
 *
 * ## Why the schemas are written by hand
 *
 * Four schemas: one string, one string plus a two-value enum, an empty object,
 * one optional boolean. Generating those from zod would mean adding
 * `zod-to-json-schema` and trusting its output to match what the tool actually
 * validates. Written here, the descriptor and the tool sit in the same review.
 *
 * The descriptions are **rewritten for a foreign reader**, not copied. The
 * originals were written for Umbra's own prompt and reference tools this server
 * does not publish — `list_adrs` tells the model to "read the selected ADR with
 * safe_read_file", which is not available here.
 */

/** A published tool: how it is advertised, and how it is invoked. */
export interface PublishedTool {
  /** What `tools/list` advertises. */
  readonly descriptor: McpToolDescriptor;
  /** Runs the tool and maps its output across the DTO boundary. */
  readonly invoke: (args: Record<string, unknown>) => Promise<McpToolResult>;
}

/**
 * Minimal structural view of a LangChain tool, so this catalog does not depend
 * on the framework's concrete types.
 */
interface InvokableTool {
  invoke: (input: unknown) => Promise<unknown>;
}

/**
 * Calls an Umbra tool and normalises whatever it returns to a string.
 *
 * Every published tool returns a string today. The coercion is here so a tool
 * that starts returning something structured surfaces as readable text rather
 * than as `[object Object]` in a foreign model's context.
 *
 * @param tool - The LangChain tool to invoke.
 * @param args - Validated arguments.
 * @returns The tool's output as a string.
 */
async function runTool(tool: unknown, args: Record<string, unknown>): Promise<string> {
  const output = await (tool as InvokableTool).invoke(args);
  return typeof output === 'string' ? output : JSON.stringify(output, null, 2);
}

/**
 * Builds the `list_adrs` publication.
 *
 * @returns The published tool.
 */
function publishListAdrs(): PublishedTool {
  return {
    descriptor: {
      name: 'list_adrs',
      description:
        'Lists this repository\'s Architectural Decision Records — path, title, status and a compact ' +
        'summary — without returning their bodies. Use it to find out *why* the code is shaped the way ' +
        'it is before reading source. Read the full record yourself from the path it returns.',
      inputSchema: {
        type: 'object',
        properties: {
          refresh: {
            type: 'boolean',
            description: 'Rebuild the cached catalog instead of reading it.',
            default: false,
          },
        },
        additionalProperties: false,
      },
    },
    invoke: async (args) => {
      const refresh = args.refresh === true;
      return toToolResult(await runTool(listAdrsTool, { refresh }));
    },
  };
}

/**
 * Builds the `query_dependency_graph` publication.
 *
 * @returns The published tool.
 */
function publishDependencyGraph(): PublishedTool {
  return {
    descriptor: {
      name: 'query_dependency_graph',
      description:
        'Queries the AST-level dependency graph for one TypeScript file: which files it imports ' +
        '(outbound), or which files import it (inbound). Answers "what breaks if I change this?" ' +
        'without reading the whole tree.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: 'Repository-relative path to a .ts file, e.g. src/core/rag/retriever.ts',
          },
          direction: {
            type: 'string',
            enum: ['inbound', 'outbound'],
            description: 'inbound = files that import this one; outbound = files this one imports.',
          },
        },
        required: ['filePath', 'direction'],
        additionalProperties: false,
      },
    },
    invoke: async (args) => {
      const filePath = typeof args.filePath === 'string' ? args.filePath : undefined;
      const direction = args.direction;

      if (filePath === undefined || filePath.trim().length === 0) {
        return toErrorResult('filePath is required and must be a non-empty string.');
      }
      if (direction !== 'inbound' && direction !== 'outbound') {
        return toErrorResult('direction is required and must be "inbound" or "outbound".');
      }

      return toToolResult(await runTool(queryDependencyGraphTool, { filePath, direction }));
    },
  };
}

/**
 * Builds the `run_integrity_check` publication.
 *
 * The empty schema is load-bearing, not an oversight: the tool derives its root
 * from the root pinned at launch and **must not** accept one from a caller.
 * Taking a path here would reopen the traversal surface ADR-011 closed and hand
 * it to a remote client (ADR-024, constraint 3).
 *
 * @returns The published tool.
 */
function publishIntegrityCheck(): PublishedTool {
  return {
    descriptor: {
      name: 'run_integrity_check',
      description:
        'Runs the TypeScript compiler in no-emit mode over the repository this server was launched ' +
        'against, and reports type errors. Takes no arguments: the directory is fixed at launch and ' +
        'cannot be chosen by the caller.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    invoke: async () => toToolResult(await runTool(integrityCheckTool, {})),
  };
}

/**
 * Builds the `ask_codebase` publication.
 *
 * Published only when embeddings are available; see `buildToolCatalog`.
 *
 * @param decorate - Adds index provenance to a successful answer.
 * @returns The published tool.
 */
function publishAskCodebase(decorate: (text: string) => string): PublishedTool {
  return {
    descriptor: {
      name: 'ask_codebase',
      description:
        'Semantic search over this repository, returning the most relevant code with each file\'s ' +
        'imports and structural skeleton. Ask in natural language ("where is the webhook signature ' +
        'verified?") rather than by keyword. Every answer states which embedding index produced it.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'A question about logic or functionality, in natural language.',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    invoke: async (args) => {
      const query = typeof args.query === 'string' ? args.query : undefined;
      if (query === undefined || query.trim().length === 0) {
        return toErrorResult('query is required and must be a non-empty string.');
      }

      const raw = await runTool(askCodebaseTool, { query });
      const mapped = toToolResult(raw);

      if (mapped.isError === true) return mapped;

      return {
        content: [{ type: 'text', text: decorate(mapped.content[0]?.text ?? '') }],
      };
    },
  };
}

/**
 * Assembles the published catalog.
 *
 * ## Why `ask_codebase` is conditional
 *
 * Three of the four tools are free and need no credentials. `ask_codebase`
 * embeds the query, which under Vertex costs money and requires ADC, and under
 * Ollama requires a running daemon with the model pulled. Advertising it when
 * neither holds would tell a foreign model about a tool that fails on first
 * use — the exact defect ADR-013 recorded, and worse here because the list is
 * fixed at launch and cannot be corrected mid-session.
 *
 * @param options - Whether semantic search can answer, and how to stamp it.
 * @returns The tools to publish, in advertisement order.
 */
export function buildToolCatalog(options: {
  semanticSearchAvailable: boolean;
  decorateSemanticAnswer?: (text: string) => string;
}): PublishedTool[] {
  const catalog = [publishListAdrs(), publishDependencyGraph(), publishIntegrityCheck()];

  if (options.semanticSearchAvailable) {
    catalog.unshift(publishAskCodebase(options.decorateSemanticAnswer ?? ((text) => text)));
  }

  return catalog;
}
