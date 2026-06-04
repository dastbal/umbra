import { Annotation } from "@langchain/langgraph";
import { BaseMessage } from "@langchain/core/messages";
import { TokenUsage } from "../../domain/value-objects/token-usage";
import { Money } from "../../domain/value-objects/money";

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

// ----------------------------------------------------
// ESTADO GLOBAL Y LOCAL PARA LOS AGENTES
// ----------------------------------------------------
export interface GraphState {
  messages: BaseMessage[];
  next_agent?: string | null;
  session_files: string[];
}

export const GraphAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (x, y) => x.concat(y),
    default: () => [],
  }),
  next_agent: Annotation<string | null>({
    reducer: (x, y) => y ?? x,
    default: () => null,
  }),
  session_files: Annotation<string[]>({
    reducer: (x, y) => Array.from(new Set([...x, ...y])),
    default: () => [],
  }),
  accumulatedTokens: Annotation<TokenUsage>({
    reducer: (state, update) => {
      if (!update) return state;
      const stateUsage = new TokenUsage((state as any).promptTokens || 0, (state as any).completionTokens || 0);
      const updateUsage = new TokenUsage((update as any).promptTokens || 0, (update as any).completionTokens || 0);
      return stateUsage.add(updateUsage);
    },
    default: () => new TokenUsage(0, 0),
  }),
  accumulatedCost: Annotation<Money>({
    reducer: (state, update) => {
      if (!update) return state;
      const stateObj = new Money((state as any).amount || 0, (state as any).currency || 'USD');
      const updateObj = new Money((update as any).amount || 0, (update as any).currency || 'USD');
      return stateObj.add(updateObj);
    },
    default: () => new Money(0, 'USD'),
  }),
});
