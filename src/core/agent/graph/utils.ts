import { BaseMessage, SystemMessage } from "@langchain/core/messages";

/**
 * Ensures that the message list sent to Gemini/Vertex AI follows strict rules:
 * 1. Only ONE SystemMessage is allowed.
 * 2. It MUST be the very first message in the array.
 * 
 * @param currentSystemPrompt The SystemMessage to be used as the primary role.
 * @param history The current state messages containing Human/AI/System context.
 * @returns A cleaned array of messages safe for LLM invocation.
 */
export function prepareMessagesForLlm(
  currentSystemPrompt: SystemMessage,
  history: BaseMessage[]
): BaseMessage[] {
  // Filter out any existing SystemMessage from history to prevent duplicates or misplaced markers
  const nonSystemHistory = history.filter((msg) => msg._getType() !== "system");
  
  // Prepend the current node-specific system prompt as the absolute first message
  return [currentSystemPrompt, ...nonSystemHistory];
}
