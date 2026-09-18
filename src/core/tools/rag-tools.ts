import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { RetrieverService } from "../rag/retriever";
import { clearPendingRetrievalAlias, stageRetrievalAlias } from "../rag/retrieval-memory";
import { IndexerService } from "../rag/indexer";
import { log } from "./utils/logger";
import { readIndexStamp } from '../rag/index-stamp';
import { runtimeRoot } from '../config/runtime-root';
import {
  executeCodebaseSearch,
  executeProjectInventory,
  executeWorkspaceSearch,
  formatProjectInventoryForModel,
  formatWorkspaceSearchForModel,
} from './read-only-executions';

export const askCodebaseTool = tool(
  async ({ query, context }) => {
    log.debug(`ask_codebase called with query: "${query}"`);
    log.tool(`Querying codebase: "${query}"`);
    const { result, modelContent } = await executeCodebaseSearch({ query, context });
    if (result.status === 'error') log.error(`Error during codebase query "${query}": ${result.diagnostics[0].message}`);
    return [modelContent, result] as const;
  },
  {
    name: "ask_codebase",
    description: "Deterministic hybrid and bounded-graph code search. After an earlier abstention, send the original query plus context once; only repository evidence is returned.",
    schema: z.object({
      query: z.string().describe("Query describing logic or functionality."),
      context: z.string().max(2000).optional().describe(
        "Optional clarification from the operator after an earlier search lacked evidence.",
      ),
    }),
    responseFormat: 'content_and_artifact',
  },
);

/** Maps the safe artifact types present in the pinned project without reading their content. */
export const inspectProjectTool = tool(
  async () => {
    const result = executeProjectInventory();
    return [formatProjectInventoryForModel(result), result] as const;
  },
  {
    name: 'inspect_project',
    description: 'Maps safe project artifact types and exclusions without reading file content or requiring an index.',
    schema: z.object({}),
    responseFormat: 'content_and_artifact',
  },
);

/** Finds exact literal text in safe project artifacts, including files outside the semantic index. */
export const searchWorkspaceTool = tool(
  async ({ query, path, maxMatches }) => {
    const result = executeWorkspaceSearch({
      query,
      ...(path === undefined ? {} : { path }),
      ...(maxMatches === undefined ? {} : { maxMatches }),
    });
    return [formatWorkspaceSearchForModel(result), result] as const;
  },
  {
    name: 'search_workspace',
    description: 'Searches safe workspace text for an exact literal. Use for known symbols, keys, or phrases that may be outside the semantic index. Returns live matches, not semantic ranking.',
    schema: z.object({
      query: z.string().trim().min(1).max(500).describe('Exact literal text to find.'),
      path: z.string().min(1).optional().describe('Optional repository-relative file or directory to search.'),
      maxMatches: z.number().int().min(1).max(100).optional().describe('Maximum matches to return; defaults to 100.'),
    }),
    responseFormat: 'content_and_artifact',
  },
);

export const refreshIndexTool = tool(
  async () => {
    log.sys("🔄 Starting full project re-indexing...");
    try {
      const indexer = new IndexerService();
      await indexer.indexProject();
      log.sys("✅ Re-indexing completed successfully.");
      return "✅ Index successfully updated.";
    } catch (error: any) {
      log.error(`❌ Indexing failed: ${error.message}`);
      return `❌ Critical error while attempting to index the project: ${error.message}`;
    }
  },
  {
    name: "refresh_project_index",
    description: "Triggers a forced, full re-indexing of the project codebase.",
    schema: z.object({}),
  },
);
