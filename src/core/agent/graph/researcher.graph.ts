import { StateGraph, START, END } from "@langchain/langgraph";
import { AIMessage, ToolMessage, SystemMessage } from "@langchain/core/messages";
import { prepareMessagesForLlm } from "./utils";

import { InteractionService } from "../../interaction";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { LLMProvider } from "../../llm/provider";
import {
  askCodebaseTool, listFilesTool, safeReadFileTool, refreshIndexTool,
  analyzeCodeStructureTool, queryDependencyGraphTool,
} from "../../tools";
import { AgentConfig, GraphAnnotation } from "./types";
import { CostTrackerService } from "../../application/services/cost-tracker.service";
import { LlmPricingConfig } from "../../infrastructure/config/llm-pricing.config";
import { TokenUsage } from "../../domain/value-objects/token-usage";
import { Money } from "../../domain/value-objects/money";

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
      `You are a Senior Knowledge Discovery Expert (Researcher). Your mission is to map the project DNA and provide high-fidelity context for the Coder.

      🧠 KNOWLEDGE DISCOVERY (THE GOLDEN THREAD):
      - Use 'ask_codebase' as your primary brain. Do not just search; understand ARCHITECTURE and INTENT.
      - Before answering, trace the "Golden Thread": if you find a Service, find its DTOs, Entities, and parent Module.
      - Deliver a complete context window. The Coder should not have to guess about imports or naming.

      📂 EXPLORATION STRATEGY:
      1. Seek Existing Patterns: Identify how the project implements DDD or NestJS before suggesting a path.
      2. READ-BEFORE-PROPOSE (The Surgeon's Rule): NEVER propose a change without reading the actual file contents using 'safe_read_file'. 
      3. Verify: Use 'list_files' and 'analyze_codebase' to confirm the directory structure.

      - Root is ${process.cwd()}. Use RELATIVE PATHS only (src/...).`
    );

    const pricingConfig = new LlmPricingConfig();
    const costTracker = new CostTrackerService(pricingConfig);
    try {
      const response = await researcherModel.invoke(
        prepareMessagesForLlm(sysPrompt, state.messages, "Researcher") as any
      );

      
      let tokens = new TokenUsage(0, 0);
      let cost = new Money(0, 'USD');
      const msg = response as any;
      const metadata = msg.usage_metadata || (msg.response_metadata ? msg.response_metadata.usage : undefined);
      
      if (metadata) {
         tokens = new TokenUsage(metadata.input_tokens || metadata.prompt_tokens || 0, metadata.output_tokens || metadata.completion_tokens || 0);
         const model = context?.modelName || process.env.GOOGLE_CLOUD_MODEL_NAME || 'gemini-1.5-pro';
         cost = costTracker.calculateCost(model, tokens);
      }

      
      task.succeed(`Researcher investigation reasoning complete [Tokens: ${tokens.promptTokens} in / ${tokens.completionTokens} out | Cost: ${cost.amount.toFixed(4)} USD]`);

      return { messages: [response], accumulatedTokens: tokens, accumulatedCost: cost };
    } catch (error: any) {
      task.fail(`Researcher LLM Error: ${error.message}`);
      return { messages: [new SystemMessage(`[SYSTEM ERROR]: API Crash in Researcher. Error: ${error.message}`)] };
    }
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
      const lastMessage = state.messages[state.messages.length - 1] as any;
      if (lastMessage._getType() === "system" && lastMessage.content.toString().startsWith("[SYSTEM ERROR]")) return "researcher_agent";
      return (lastMessage.tool_calls && lastMessage.tool_calls.length > 0) ? "researcher_tools" : END;
    })
    .addEdge("researcher_tools", "researcher_agent");

  return researcherGraph.compile({ checkpointer });
}
