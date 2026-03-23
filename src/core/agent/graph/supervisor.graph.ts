import { StateGraph, START, END, CompiledStateGraph } from "@langchain/langgraph";
import { HumanMessage, SystemMessage, AIMessage } from "@langchain/core/messages";
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
 * This module orchestrates a Multi-Agent system using LangGraph.
 * It follows the Supervisor pattern where a central node decides which specialist (Researcher or Coder)
 * should handle the next sub-task based on the conversation history.
 */

/**
 * Schema for the routing decision made by the Supervisor.
 * Uses Zod for strict validation and compatibility with Vertex AI structured output.
 */
const routeTaskSchema = z.object({
  reasoning: z.string()
    .describe("Step-by-step reasoning on what to do next based on the user request and history. Think: does this require code modification? If so, did I already call the Coder?"),
  assignee: z.enum(["Researcher", "Coder", "FINISH"])
    .describe("The agent to assign the task to. Researcher for discovery, Coder for implementation, or FINISH if the request is completed."),
  instruction: z.string()
    .describe("The specific technical instructions for the assigned worker (ignored if FINISH)."),
  finalResponse: z.string().optional()
    .describe("If assignee is FINISH, provide a polite, human-friendly response to the user.")
});

/**
 * Creates and compiles the Main Supervisor Graph.
 * 
 * @param checkpointer - SQLite saver for persistence.
 * @param interactor - Service to handle CLI feedback and tasks.
 * @param researcherApp - Compiled sub-graph for the Researcher agent.
 * @param coderApp - Compiled sub-graph for the Coder agent.
 * @param threadId - Unique ID for the current execution thread.
 * @param context - Optional configuration for the LLM (modelName, temperature).
 * @returns A compiled LangGraph application.
 */
export function createSupervisorGraph(
  checkpointer: SqliteSaver,
  interactor: InteractionService,
  researcherApp: CompiledStateGraph<any, any, any, any, any, any>,
  coderApp: CompiledStateGraph<any, any, any, any, any, any>,
  threadId: string,
  context?: AgentConfig
) {
  // Instance of the lead LLM provider
  const supervisorModel = LLMProvider.createModel(context || { temperature: 0 });

  /**
   * Supervisor Node: Analyzes state and delegates work.
   * Forces structured output to ensure reliable routing decisions.
   */
  const supervisorAgentNode = async (state: typeof GraphAnnotation.State) => {
    const task = interactor.startTask("Supervisor Reasoning...");
    const sysPrompt = `You are the Lead Principal Software Engineer (Supervisor) specialized in NestJS.
    Orchestrate a high-level team to deliver enterprise-grade code (DDD, NestJS Best Practices).
    
    ⚙️ SUPERVISION PROTOCOL:
    1. RESEARCH FIRST: ALWAYS delegate to 'Researcher' to find patterns (Entities, DTOs, Modules) before touching code.
    2. IMPLEMENT & VALIDATE: Delegate to 'Coder' ONLY when the context is clear.
    3. FINISH: Return a concise summary once verified.
    
    - Strict TypeScript. No 'any'.
    - Use RELATIVE PATHS: ${process.cwd()}. Root is src/.`;
    
    // Using structured output for exact field mapping
    const structuredModel = (supervisorModel as any).withStructuredOutput(routeTaskSchema);
    let routingResult: any;
    
    const pricingConfig = new LlmPricingConfig();
    const costTracker = new CostTrackerService(pricingConfig);
    try {
      routingResult = await structuredModel.invoke([new SystemMessage(sysPrompt), ...state.messages] as any);
    } catch (error: any) {
      task.fail(`Supervisor LLM Error: ${error.message}`);
      return { 
        messages: [new SystemMessage(`[SYSTEM ERROR]: API Crash or Invalid Output. Ensure your schema is valid and there are no empty parts. Error: ${error.message}`)], 
        next_agent: "supervisor" 
      };
    }
    
    let tokens = new TokenUsage(0, 0);
    let cost = new Money(0, 'USD');
    const metadata = (routingResult as any).usage_metadata;
    if (metadata) {
       tokens = new TokenUsage(metadata.input_tokens || 0, metadata.output_tokens || 0);
       const model = context?.modelName || process.env.GOOGLE_CLOUD_MODEL_NAME || 'gemini-1.5-pro';
       cost = costTracker.calculateCost(model, tokens);
    }

    let nextAgent = routingResult.assignee || "FINISH";
    const instruction = routingResult.instruction || "Task completed.";

    // Validation to prevent hallucinated finishing
    if (nextAgent === "FINISH" && !state.messages.some(m => m.content.toString().includes('[Coder Result]'))) {
      const txt = state.messages.map(m => m.content.toString().toLowerCase()).join(" ");
      if (txt.includes('implement') || txt.includes('refactor') || txt.includes('update') || txt.includes('agrega') || txt.includes('crea')) {
         nextAgent = "Researcher"; // Force fallback to start with Research
      }
    }

    // Track the internal decision as a hidden tool call for tracing
    const supervisorMsg = new AIMessage({
      content: `Decision: ${nextAgent}. Reason: ${instruction}`,
      tool_calls: [{
        id: "route-" + Date.now(),
        name: "route_task",
        args: routingResult
      }]
    } as any);

    const messages: any[] = [supervisorMsg];

    if (nextAgent === "FINISH") {
      messages.push(new AIMessage(routingResult.finalResponse || instruction));
    } else {
      // HumanMessage acts as the input for the worker sub-graph
      messages.push(new HumanMessage(`[DELEGATED TO ${nextAgent}]: ${instruction}`));
    }
    
    task.succeed(`Supervisor decided: ${nextAgent} [Tokens: ${tokens.promptTokens} in / ${tokens.completionTokens} out | Cost: ${cost.amount.toFixed(4)} USD]`);
    return { messages, next_agent: nextAgent, accumulatedTokens: tokens, accumulatedCost: cost };
  };

  /**
   * Researcher Wrapper Node: Invokes the specialized Researcher sub-graph.
   */
  const invokeResearcher = async (state: typeof GraphAnnotation.State) => {
    const response = await researcherApp.invoke({ messages: state.messages }, { configurable: { thread_id: threadId } });
    const lastMsg = response.messages[response.messages.length - 1];
    return { messages: [new HumanMessage(`[Researcher Result]: ${lastMsg.content}`)] };
  };

  /**
   * Coder Wrapper Node: Invokes the specialized Coder sub-graph.
   */
  const invokeCoder = async (state: typeof GraphAnnotation.State) => {
    const response = await coderApp.invoke({ messages: state.messages }, { configurable: { thread_id: threadId } });
    const lastMsg = response.messages[response.messages.length - 1];
    return { messages: [new HumanMessage(`[Coder Result]: ${lastMsg.content}`)] };
  };

  // Define the master workflow graph
  const supervisorGraph = new StateGraph(GraphAnnotation)
    .addNode("supervisor", supervisorAgentNode)
    .addNode("Researcher", invokeResearcher)
    .addNode("Coder", invokeCoder)
    .addEdge(START, "supervisor")
    .addConditionalEdges("supervisor", (state) => {
      // Routing logic based on supervisor's decision
      if (state.next_agent === "supervisor") return "supervisor"; // Auto-recovery loop
      if (state.next_agent === "Researcher") return "Researcher";
      if (state.next_agent === "Coder") return "Coder";
      return END;
    })
    .addEdge("Researcher", "supervisor")
    .addEdge("Coder", "supervisor");

  return supervisorGraph.compile({ checkpointer });
}
