import { BaseMessage, SystemMessage } from "@langchain/core/messages";
import * as fs from 'fs';
import * as path from 'path';

/**
 * Logs the messages to a local file for debugging purposes.
 * This remains local only (ignored by git).
 */
function debugLogPayload(nodeName: string, messages: BaseMessage[]) {
  const filePath = path.join(process.cwd(), '.debug_llm_payload.json');
  const logEntry = {
    timestamp: new Date().toISOString(),
    nodeName,
    messageCount: messages.length,
    messages: messages.map(m => ({
      type: m._getType(),
      content: m.content.toString().substring(0, 500) + (m.content.toString().length > 500 ? '...' : '')
    }))
  };

  try {
    fs.appendFileSync(filePath, JSON.stringify(logEntry, null, 2) + '\n');
  } catch (e) {
    // Silent fail for logging errors
  }
}

/**
 * Ensures that the message list sent to Gemini/Vertex AI follows strict rules:
 * 1. Only ONE SystemMessage is allowed.
 * 2. It MUST be the very first message in the array.
 * 
 * @param currentSystemPrompt The SystemMessage to be used as the primary role.
 * @param history The current state messages containing Human/AI/System context.
 * @param nodeName Identifies the agent calling the model (for debugging).
 * @returns A cleaned array of messages safe for LLM invocation.
 */
export function prepareMessagesForLlm(
  currentSystemPrompt: SystemMessage,
  history: BaseMessage[],
  nodeName: string = "Unknown"
): BaseMessage[] {
  // Filter out any existing SystemMessage from history to prevent duplicates or misplaced markers
  const nonSystemHistory = (history || []).filter((msg) => msg && msg._getType() !== "system");
  
  // Ensure the current system prompt is valid
  if (!currentSystemPrompt || !currentSystemPrompt.content) {
    throw new Error(`[${nodeName}] Invalid System Prompt: content is empty.`);
  }

  const finalMessages = [currentSystemPrompt, ...nonSystemHistory];

  // Debug logging
  debugLogPayload(nodeName, finalMessages);

  return finalMessages;
}
