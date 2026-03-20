import { StateGraph, START, END } from "@langchain/langgraph";
import { AIMessage, ToolMessage, SystemMessage } from "@langchain/core/messages";
import { InteractionService } from "../../interaction";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { LLMProvider } from "../../llm/provider";
import {
  askCodebaseTool,
  listFilesTool,
  safeReadFileTool,
  refreshIndexTool,
  analyzeCodeStructureTool,
  queryDependencyGraphTool,
} from "../../tools";
import { AgentConfig, GraphAnnotation } from "./types";

/**
 * Creates and compiles the Researcher Sub-graph
 */
export function createResearcherGraph(
  checkpointer: SqliteSaver,
  interactor: InteractionService,
  context?: AgentConfig
) {
  const researchTools = [
    askCodebaseTool, listFilesTool, safeReadFileTool, refreshIndexTool,
    analyzeCodeStructureTool, queryDependencyGraphTool,
  ];

  const researcherModel = LLMProvider.createModel(context || { temperature: 0 }).bindTools(researchTools);

  const researcherAgentNode = async (state: typeof GraphAnnotation.State) => {
    const task = interactor.startTask("Researcher Investigating...");
    const sysPrompt = new SystemMessage(
      `You are a Senior Knowledge discovery expert (Researcher). Your mission is to map the codebase DNA.
      
      🧠 KNOWLEDGE DISCOVERY (RAG):
      - Use 'ask_codebase' as your primary brain. It's not just a search; use it to understand ARCHITECTURE, INTENT, and SYMBOL relations.
      - Before answering, trace the "golden thread": if you find a service, find its DTOs, Entities, and Modules.
      - Provide the Coder with a full "X-Ray" of the feature context, not just one file.
      
      📂 EXPLORATION STRATEGY:
      1. Seek Patterns: Identify existing coding styles (DDD, NestJS) before proposing anything.
      2. Read-Before-Write: Deliver exact file contents and skeletons to ensure the Coder doesn't break integrity.
      3. Precise Navigation: Use 'list_files' and 'analyze_codebase' to verify directory structures.
      
      - Root is ${process.cwd()} (src/). Use RELATIVE PATHS only.`
    );
    const response = await researcherModel.invoke([sysPrompt, ...state.messages] as any);
    task.succeed("Researcher investigation reasoning complete");
    return { messages: [response] };
  };

  const researcherToolsNode = async (state: typeof GraphAnnotation.State) => {
    const task = interactor.startTask("Researcher Tools Executing...");
    const lastMessage = state.messages[state.messages.length - 1] as AIMessage;
    const toolMessages: ToolMessage[] = [];
    if (lastMessage.tool_calls) {
      for (const toolCall of lastMessage.tool_calls) {
        const tool = researchTools.find((t) => t.name === toolCall.name);
        if (tool) {
          interactor.logDebug(`Executing ${toolCall.name}...`);
          const output = await (tool as any).invoke(toolCall.args);
          toolMessages.push(new ToolMessage({
            tool_call_id: toolCall.id!,
            content: typeof output === "string" ? output : JSON.stringify(output)
          }));
        }
      }
    }
    task.succeed(`Researcher tools executed: ${toolMessages.length} results.`);
    return { messages: toolMessages };
  };

  const researcherGraph = new StateGraph(GraphAnnotation)
    .addNode("researcher_agent", researcherAgentNode)
    .addNode("researcher_tools", researcherToolsNode)
    .addEdge(START, "researcher_agent")
    .addConditionalEdges("researcher_agent", (state) => {
      const lastMessage = state.messages[state.messages.length - 1] as AIMessage;
      return (lastMessage.tool_calls && lastMessage.tool_calls.length > 0) ? "researcher_tools" : END;
    })
    .addEdge("researcher_tools", "researcher_agent");

  return researcherGraph.compile({ checkpointer });
}
