import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { RetrieverService } from "../rag/retriever";
import { clearPendingRetrievalAlias, stageRetrievalAlias } from "../rag/retrieval-memory";
import { IndexerService } from "../rag/indexer";
import { log } from "./utils/logger";
import { readIndexStamp } from '../rag/index-stamp';
import { runtimeRoot } from '../config/runtime-root';
import { executeCodebaseSearch } from './read-only-executions';

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
    description: "Hybrid code search with dependency context. After an earlier abstention, send the original query plus context once; only repository evidence is returned.",
    schema: z.object({
      query: z.string().describe("Query describing logic or functionality."),
      context: z.string().max(2000).optional().describe(
        "Optional clarification from the operator after an earlier search lacked evidence.",
      ),
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
