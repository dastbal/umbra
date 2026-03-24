import { StateGraph, START, END, CompiledStateGraph } from "@langchain/langgraph";
import { HumanMessage, SystemMessage, AIMessage } from "@langchain/core/messages";
import { prepareMessagesForLlm } from "./utils";

import { InteractionService } from "../../interaction";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { LLMProvider } from "../../llm/provider";
import { AgentConfig, GraphAnnotation } from "./types";
import { CostTrackerService } from "../../application/services/cost-tracker.service";
import { LlmPricingConfig } from "../../infrastructure/config/llm-pricing.config";
import { TokenUsage } from "../../domain/value-objects/token-usage";
import { Money } from "../../domain/value-objects/money";
import { z } from "zod";

/**
 * @module SupervisorGraph
 * @description
 * High-level orchestrator for the Multi-Agent system.
 */

const routeTaskSchema = z.object({
  reasoning: z.string()
    .describe("Step-by-step reasoning based on project state and user intent. Think: did I already research? Do I have the context?"),
  assignee: z.enum(["Researcher", "Coder", "FINISH"])
    .describe("Researcher for discovery, Coder for implementation, or FINISH."),
  instruction: z.string()
    .describe("Clear, technical delegation details for the worker."),
  finalResponse: z.string().optional()
    .describe("Human-friendly summary for the user if FINISH.")
});

export function createSupervisorGraph(
  checkpointer: SqliteSaver,
  interactor: InteractionService,
  researcherApp: CompiledStateGraph<any, any, any, any, any, any>,
  coderApp: CompiledStateGraph<any, any, any, any, any, any>,
  threadId: string,
  context?: AgentConfig
) {
  const supervisorModel = LLMProvider.createModel(context || { temperature: 0 });

  const supervisorAgentNode = async (state: typeof GraphAnnotation.State) => {
    const task = interactor.startTask("Supervisor Reasoning...");
    
    const sysPrompt = `You are the Lead Principal Software Engineer (Supervisor) specialized in NestJS.
    Orchestrate a team of specialists to deliver production-ready, resilient code.

    💎 ARCHITECTURAL STANDARDS (UNBREAKABLE):
    1. DDD & NestJS: All solutions must follow Domain-Driven Design and NestJS best practices.
    2. THE SURGEON'S RULE (Enforcement): Never allow the 'Coder' to write code without prior research by the 'Researcher'.
    3. NO SWALLOWING ERRORS: Ensure the code robustly handles exceptions.
    4. QUALITY FIRST: You are responsible for the overall project integrity.

    ⚙️ SUPERVISION PROTOCOL:
    - DISCOVERY: ALWAYS delegate to 'Researcher' first to map the codebase DNA and find existing patterns.
    - IMPLEMENTATION: Delegate to 'Coder' ONLY when the context/files to modify are clearly identified.
    - VALIDATION: After coding, ensure the result is summarized and verified.

    - Root: ${process.cwd()}. Use RELATIVE PATHS only (e.g., 'src/...').`;

    const structuredModel = (supervisorModel as any).withStructuredOutput(routeTaskSchema, { includeRaw: true });
    let routingFull: any;
    let routingResult: any;
    
    const pricingConfig = new LlmPricingConfig();
    const costTracker = new CostTrackerService(pricingConfig);
    
    try {
      routingFull = await structuredModel.invoke(
        prepareMessagesForLlm(new SystemMessage(sysPrompt), state.messages, "Supervisor") as any
      );
      routingResult = routingFull.parsed;
    } catch (error: any) {
      task.fail(`Supervisor LLM Error: ${error.message}`);
      return { 
        messages: [new SystemMessage(`[SYSTEM ERROR]: Schema validation failure or API crash. Error: ${error.message}`)], 
        next_agent: "supervisor" 
      };
    }

    let tokens = new TokenUsage(0, 0);
    let cost = new Money(0, 'USD');
    const rawMsg = routingFull.raw as any;
    const metadata = rawMsg.usage_metadata || (rawMsg.response_metadata ? rawMsg.response_metadata.usage : undefined);
    
    if (metadata) {
       tokens = new TokenUsage(metadata.input_tokens || metadata.prompt_tokens || 0, metadata.output_tokens || metadata.completion_tokens || 0);
       const model = context?.modelName || process.env.GOOGLE_CLOUD_MODEL_NAME || 'gemini-1.5-pro';
       cost = costTracker.calculateCost(model, tokens);
    }


    let nextAgent = routingResult.assignee || "FINISH";
    const instruction = routingResult.instruction || "Finalizing task.";

    // Logic fallback to prevent premature finishing
    if (nextAgent === "FINISH" && !state.messages.some(m => m.content.toString().includes('[Coder Result]'))) {
      const history = state.messages.map(m => m.content.toString().toLowerCase()).join(" ");
      if (history.includes('crea') || history.includes('update') || history.includes('refactor') || history.includes('arregla')) {
         nextAgent = "Researcher";
      }
    }

    const decisionMsg = new AIMessage({
      content: `[Supervisor Decision]: ${nextAgent}. Reasoning: ${instruction}`,
      tool_calls: [{ id: "route-" + Date.now(), name: "route_task", args: routingResult }]
    } as any);

    const messages: any[] = [decisionMsg];

    if (nextAgent === "FINISH") {
      messages.push(new AIMessage(routingResult.finalResponse || instruction));
    } else {
      messages.push(new HumanMessage(`[DELEGATED TO ${nextAgent}]: ${instruction}`));
    }
    
    task.succeed(`Supervisor decided: ${nextAgent} [Tokens: ${tokens.promptTokens} in / ${tokens.completionTokens} out | Cost: ${cost.amount.toFixed(4)} USD]`);

    return { messages, next_agent: nextAgent, accumulatedTokens: tokens, accumulatedCost: cost };
  };

  const invokeResearcher = async (state: typeof GraphAnnotation.State) => {
    const response = await researcherApp.invoke({ messages: state.messages }, { configurable: { thread_id: threadId } });
    const lastMsg = response.messages[response.messages.length - 1];
    return { messages: [new HumanMessage(`[Researcher Result]: ${lastMsg.content}`)] };
  };

  const invokeCoder = async (state: typeof GraphAnnotation.State) => {
    const response = await coderApp.invoke({ messages: state.messages }, { configurable: { thread_id: threadId } });
    const lastMsg = response.messages[response.messages.length - 1];
    return { messages: [new HumanMessage(`[Coder Result]: ${lastMsg.content}`)] };
  };

  const supervisorGraph = new StateGraph(GraphAnnotation)
    .addNode("supervisor", supervisorAgentNode)
    .addNode("Researcher", invokeResearcher)
    .addNode("Coder", invokeCoder)
    .addEdge(START, "supervisor")
    .addConditionalEdges("supervisor", (state) => {
      if (state.next_agent === "supervisor") return "supervisor";
      if (state.next_agent === "Researcher") return "Researcher";
      if (state.next_agent === "Coder") return "Coder";
      return END;
    })
    .addEdge("Researcher", "supervisor")
    .addEdge("Coder", "supervisor");

  return supervisorGraph.compile({ checkpointer });
}
