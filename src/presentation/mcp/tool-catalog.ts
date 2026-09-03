import {
  askCodebaseTool,
  integrityCheckTool,
  listAdrsTool,
  queryDependencyGraphTool,
} from '../../core/tools';
import { z } from 'zod';
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
 * ## Why the published schema is zod, and separate from the tool's own
 *
 * The SDK takes a zod raw shape and derives the JSON Schema itself, so the
 * hand-written `inputSchema` objects this file used to carry are gone —
 * hand-maintained JSON Schema beside a zod validator is two descriptions of
 * one contract, and they drift.
 *
 * The shapes are declared here rather than taken from each Umbra tool's own
 * `schema`, and that is deliberate, not duplication for its own sake. The
 * internal schemas carry `.describe()` text written for **Umbra's own prompt**:
 * `list_adrs` tells the model to "read the selected ADR with safe_read_file",
 * a tool this server does not publish. Reusing them would leak internal
 * vocabulary into a foreign model's context, which is precisely what
 * `dto-mapper.ts` exists to prevent on the way out.
 *
 * So: one published schema per tool, in one place, in the same language the
 * SDK speaks — and the Umbra tool still validates its own input underneath,
 * which is defence in depth rather than redundancy.
 */

/** A published tool: how it is advertised, and how it is invoked. */
export interface PublishedTool {
  /** Tool name, as the client calls it. */
  readonly name: string;
  /** Description written for a foreign reader, not for Umbra's own prompt. */
  readonly description: string;
  /**
   * Argument shape as a zod raw shape, which is what `registerTool` takes.
   *
   * An empty object means the tool takes no arguments — load-bearing for
   * `run_integrity_check`, whose root must come from the pinned launch value
   * and never from a caller (ADR-024, constraint 3).
   */
  readonly inputSchema: z.ZodRawShape;
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
    name: 'list_adrs',
    description:
      'Lists this repository\'s Architectural Decision Records — path, title, status and a compact ' +
      'summary — without returning their bodies. Use it to find out *why* the code is shaped the way ' +
      'it is before reading source. Read the full record yourself from the path it returns.',
    inputSchema: {
      refresh: z
        .boolean()
        .optional()
        .describe('Rebuild the cached catalog instead of reading it.'),
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
    name: 'query_dependency_graph',
    description:
      'Queries the AST-level dependency graph for one TypeScript file: which files it imports ' +
      '(outbound), or which files import it (inbound). Answers "what breaks if I change this?" ' +
      'without reading the whole tree.',
    inputSchema: {
      filePath: z
        .string()
        .min(1)
        .describe('Repository-relative path to a .ts file, e.g. src/core/rag/retriever.ts'),
      direction: z
        .enum(['inbound', 'outbound'])
        .describe('inbound = files that import this one; outbound = files this one imports.'),
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
    name: 'run_integrity_check',
    description:
      'Runs the TypeScript compiler in no-emit mode over the repository this server was launched ' +
      'against, and reports type errors. Takes no arguments: the directory is fixed at launch and ' +
      'cannot be chosen by the caller.',
    inputSchema: {},
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
    name: 'ask_codebase',
    description:
      'Semantic search over this repository, returning the most relevant code with each file\'s ' +
      'imports and structural skeleton. Ask in natural language ("where is the webhook signature ' +
      'verified?") rather than by keyword. Every answer states which embedding index produced it.',
    inputSchema: {
      query: z
        .string()
        .min(1)
        .describe('A question about logic or functionality, in natural language.'),
      context: z
        .string()
        .max(2000)
        .optional()
        .describe('Optional clarification to retry once after the original query lacks evidence.'),
    },
    invoke: async (args) => {
      const query = typeof args.query === 'string' ? args.query : undefined;
      const context = typeof args.context === 'string' ? args.context : undefined;
      if (query === undefined || query.trim().length === 0) {
        return toErrorResult('query is required and must be a non-empty string.');
      }

      const raw = await runTool(askCodebaseTool, { query, context });
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
