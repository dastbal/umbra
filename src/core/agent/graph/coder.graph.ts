import { StateGraph, START, END } from "@langchain/langgraph";
import { AIMessage, ToolMessage, SystemMessage } from "@langchain/core/messages";
import { prepareMessagesForLlm } from "./utils";

import { InteractionService } from "../../interaction";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { LLMProvider } from "../../llm/provider";
import {
  executeTestsTool,
  integrityCheckTool,
  safeWriteFileTool,
  executeCommandTool,
  askHumanTool,
  deleteFileTool
} from "../../tools";
import { AgentConfig, GraphAnnotation } from "./types";
import { CostTrackerService } from "../../application/services/cost-tracker.service";
import { LlmPricingConfig } from "../../infrastructure/config/llm-pricing.config";
import { TokenUsage } from "../../domain/value-objects/token-usage";
import { Money } from "../../domain/value-objects/money";

/**
 * Creates and compiles the Coder Sub-graph
 */
export function createCoderGraph(
  checkpointer: SqliteSaver,
  interactor: InteractionService,
  context?: AgentConfig
) {
  const safeCodingTools = [integrityCheckTool, executeTestsTool, safeWriteFileTool];
  const dangerousCodingTools = [deleteFileTool, executeCommandTool, askHumanTool];

  const coderModel = LLMProvider.createModel(context || { temperature: 0 })
    .bindTools([...safeCodingTools, ...dangerousCodingTools]);

  const coderAgentNode = async (state: typeof GraphAnnotation.State) => {
    const task = interactor.startTask("Coder Reasoning...");
    const sysPrompt = new SystemMessage(
      `You are a Principal Software Engineer (Coder) specialized in NestJS.
      
      💎 QUALITY STANDARDS:
      - DDD & NestJS: Follow entities, DTOs (with class-validator), and clean modules.
      - Surgeon's Rule: READ-BEFORE-WRITE. Never overwrite without understanding the logic first.
      - Anti-Regression: Preserve TSDocs, comments, and unrelated business logic.
      
      🧪 TESTING PROTOCOL (MANDATORY):
      1. No Regressions: Run 'integrity_check' and 'run_tests' after any write.
      2. Auto-Fix: If tests fail, fix it yourself. Ask for help only after 3 tries.
      
      - Strict TypeScript. NO 'any'.
      - No mass deletions.
      - Relative paths in ${process.cwd()} (src/).`
    );
    const pricingConfig = new LlmPricingConfig();
    const costTracker = new CostTrackerService(pricingConfig);
    try {
      const response = await coderModel.invoke(prepareMessagesForLlm(sysPrompt, state.messages) as any);

      
      let tokens = new TokenUsage(0, 0);
      let cost = new Money(0, 'USD');
      const metadata = (response as any).usage_metadata;
      if (metadata) {
         tokens = new TokenUsage(metadata.input_tokens || 0, metadata.output_tokens || 0);
         const model = context?.modelName || process.env.GOOGLE_CLOUD_MODEL_NAME || 'gemini-1.5-pro';
         cost = costTracker.calculateCost(model, tokens);
      }
      
      task.succeed(`Coder reasoning complete [Tokens: ${tokens.promptTokens} in / ${tokens.completionTokens} out | Cost: ${cost.amount.toFixed(4)} USD]`);
      return { messages: [response], accumulatedTokens: tokens, accumulatedCost: cost };
    } catch (error: any) {
      task.fail(`Coder LLM Error: ${error.message}`);
      return { messages: [new SystemMessage(`[SYSTEM ERROR]: API Crash. Check your previous output formats or tool calls. Error: ${error.message}`)] };
    }
  };

  const safeActorNode = async (state: typeof GraphAnnotation.State) => {
    const task = interactor.startTask("Coder Executing SAFE tools...");
    const lastMessage = state.messages[state.messages.length - 1] as AIMessage;
    const toolMessages: ToolMessage[] = [];
    const newSessionFiles: string[] = [];
    
    if (lastMessage.tool_calls) {
      for (const toolCall of lastMessage.tool_calls) {
        const tool = safeCodingTools.find((t) => t.name === toolCall.name);
        if (tool) {
          interactor.logDebug(`Executing SAFE tool ${toolCall.name}...`);
          const output = await (tool as any).invoke(toolCall.args);
          if (toolCall.name === "safe_write_file" && typeof output === "string") {
            const metaMatch = output.match(/\[METADATA: (.*)\]/);
            if (metaMatch) newSessionFiles.push(JSON.parse(metaMatch[1]).path);
          }
          toolMessages.push(new ToolMessage({
            tool_call_id: toolCall.id!,
            content: typeof output === "string" ? output : JSON.stringify(output)
          }));
        }
      }
    }
    task.succeed(`Safe tools executed: ${toolMessages.length} results.`);
    return { messages: toolMessages, session_files: newSessionFiles };
  };

  const dangerousActorNode = async (state: typeof GraphAnnotation.State) => {
    interactor.logWarning("⚠️ ENTRANDO A NODO PELIGROSO - SE ESPERARÁ APROBACIÓN");
    const lastMessage = state.messages[state.messages.length - 1] as AIMessage;
    const toolMessages: ToolMessage[] = [];
    
    if (lastMessage.tool_calls) {
      for (const toolCall of lastMessage.tool_calls) {
        const tool = dangerousCodingTools.find((t) => t.name === toolCall.name);
        if (tool) {
          interactor.logDebug(`Executing DANGEROUS tool ${toolCall.name}...`);
          const output = await (tool as any).invoke(toolCall.args);
          toolMessages.push(new ToolMessage({
            tool_call_id: toolCall.id!,
            content: typeof output === "string" ? output : JSON.stringify(output)
          }));
        }
      }
    }
    return { messages: toolMessages };
  };

  const coderGraph = new StateGraph(GraphAnnotation)
    .addNode("coder_agent", coderAgentNode)
    .addNode("safe_actor", safeActorNode)
    .addNode("dangerous_actor", dangerousActorNode)
    .addEdge(START, "coder_agent")
    .addConditionalEdges("coder_agent", (state) => {
      const lastMessage = state.messages[state.messages.length - 1] as any;
      if (lastMessage._getType() === "system" && lastMessage.content.toString().startsWith("[SYSTEM ERROR]")) return "coder_agent"; // Auto-recovery loop
      if (!lastMessage.tool_calls || lastMessage.tool_calls.length === 0) return END;
      const toolCall = lastMessage.tool_calls[0];
      if (safeCodingTools.some(t => t.name === toolCall.name)) return "safe_actor";
      if (dangerousCodingTools.some(t => t.name === toolCall.name)) return "dangerous_actor";
      return END;
    })
    .addEdge("safe_actor", "coder_agent")
    .addEdge("dangerous_actor", "coder_agent");

  // HITL Pause on exactly dangerous_actor inside Coder graph
  return coderGraph.compile({
    checkpointer,
    interruptBefore: ["dangerous_actor"]
  });
}
