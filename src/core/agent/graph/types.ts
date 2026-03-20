import { Annotation } from "@langchain/langgraph";
import { BaseMessage } from "@langchain/core/messages";

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
});
