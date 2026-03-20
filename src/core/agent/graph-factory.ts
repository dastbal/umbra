import { Annotation, StateGraph, START, END } from "@langchain/langgraph";
import { BaseMessage, AIMessage, ToolMessage, SystemMessage } from "@langchain/core/messages";
import { InteractionService } from "../interaction";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { LLMProvider } from "../llm/provider";
import { IndexerService } from "../rag/indexer";
// @ts-ignore - Ignore moduleResolution strict checks for prebuilt exports
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { createSupervisor } from "@langchain/langgraph-supervisor";
import {
  askCodebaseTool,
  executeTestsTool,
  integrityCheckTool,
  listFilesTool,
  refreshIndexTool,
  safeReadFileTool,
  safeWriteFileTool,
  executeCommandTool,
  askHumanTool,
  deleteFileTool,
  analyzeCodeStructureTool,
  queryDependencyGraphTool,
} from "../tools";
import * as path from "path";
import * as fs from "fs";

export interface AgentConfig {
  modelName?: string;
  temperature?: number;
}

export interface SupervisorConfig {
  supervisorContext?: AgentConfig;
  researcherContext?: AgentConfig;
  coderContext?: AgentConfig;
  threadId?: string;
}

export class GraphAgentFactory {
  public static async create(config: SupervisorConfig = {}, interaction?: InteractionService) {
    const interactor = interaction || new InteractionService();
    const threadId = config.threadId || "cli-session";
    const rootDir = process.cwd();
    const agentDir = path.join(rootDir, ".agent");
    if (!fs.existsSync(agentDir)) fs.mkdirSync(agentDir, { recursive: true });

    // Separate SQLite Savers to isolate context and cleanly query history
    const mainDb = path.join(agentDir, "history_supervisor.db");
    const researcherDb = path.join(agentDir, "history_researcher.db");
    const coderDb = path.join(agentDir, "history_coder.db");

    const mainCheckpointer = SqliteSaver.fromConnString(mainDb);
    const researcherCheckpointer = SqliteSaver.fromConnString(researcherDb);
    const coderCheckpointer = SqliteSaver.fromConnString(coderDb);

    // Tools categorization
    const researchTools = [
      askCodebaseTool, listFilesTool, safeReadFileTool, refreshIndexTool,
      analyzeCodeStructureTool, queryDependencyGraphTool,
    ];
    // We bind safe testing/valuation directly to the Coder since the coder verifies its own work
    const codingTools = [
      safeWriteFileTool, deleteFileTool, executeCommandTool, askHumanTool,
      integrityCheckTool, executeTestsTool
    ];

    // 1. Researcher Agent
    const researcherAgent = createReactAgent({
      llm: LLMProvider.createModel(config.researcherContext || { temperature: 0 }),
      tools: researchTools,
      checkpointSaver: researcherCheckpointer,
      prompt: `You are an expert Code Researcher. Your goal is to navigate the codebase, read files, analyze structure, and find exact context. DO NOT write code. Provide detailed findings.
      ALWAYS use relative paths from the root: ${process.cwd()}
      All source code is inside the 'src' folder.`,
    });

    // 2. Coder Agent
    const coderAgent = createReactAgent({
      llm: LLMProvider.createModel(config.coderContext || { temperature: 0 }),
      tools: codingTools,
      checkpointSaver: coderCheckpointer,
      prompt: `You are a Principal Software Engineer (Coder). Your role is to write, modify, delete code, and run tests.
      💎 QUALITY STANDARDS:
      - Architecture: Follow DDD (Domain-Driven Design) and NestJS Best Practices. Strict TypeScript. NO 'any'. TSDocs required.
      - TDD: DO NOT write code without its corresponding test.
      - Always run 'integrity_check' and 'run_tests' after any modification.
      - If tests fail, AUTO-FIX. Do not give up until tests are green.
      - NEVER overwrite a file without reading it first.
      - ALWAYS use relative paths from: ${process.cwd()}`,
    });

    // 3. Overall Supervisor
    const supervisorModel = LLMProvider.createModel(config.supervisorContext || { temperature: 0 });
    const supervisorWorkflow = createSupervisor({
      agents: [
        { name: "Researcher", agent: researcherAgent },
        { name: "Coder", agent: coderAgent },
      ],
      llm: supervisorModel as any,
      prompt: `You are the Lead Principal Edge Supervisor orchestrating a NestJS engineering team.
      Your job is to break down the user request and delegate to the right worker: 'Researcher' to gather info, or 'Coder' to write and test code.
      You operate with a "Lightweight HITL" protocol. You MUST delegate tasks correctly:
      1. Delegate to Researcher if you need to understand existing files, classes or structure.
      2. Delegate to Coder if you need to create/edit files or run tests.
      After workers finish, respond with a highly concise summary of what was completed to the user.`,
    });

    // We can add the Indexer logic just before delegating if needed, but the Supervisor graph is managed by createSupervisor.
    // However, to keep the Indexer functionality intact on startup without polluting the agents logic:
    const indexerTask = interactor.startTask("Syncing codebase index...");
    const indexer = new IndexerService();
    await indexer.indexProject();
    indexerTask.succeed("Codebase index synced");

    // Compile the supervisor workflow into an executable app
    // We set interruptBefore on specific nodes if we need HITL breakpoints.
    // Within `createReactAgent`, the tools node is named "tools".
    // Unfortunately, createSupervisor does not elegantly bubble up nested sub-graph node interrupts natively if we compile the outer wrapper.
    // However, for the Outer supervisor, we can compile it with our main checkpointer.
    const app = supervisorWorkflow.compile({ 
      checkpointer: mainCheckpointer
      // Note: Full Sub-graph HITL integration might require intercepting tool calls inside the Coder.
    });

    return app;
  }
}

