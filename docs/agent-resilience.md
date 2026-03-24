# Agent Resilience & Vertex AI Compatibility

This document describes the implementation of message-level resilience and compatibility for Vertex AI (Google Gemini) within the Multi-Agent system.

## The Challenge

Vertex AI (Gemini) models have strict message requirements:
1. **Single System Message**: Precisely one `SystemMessage` is allowed per invocation.
2. **First Position**: The `SystemMessage` must be the absolute first element in the message list.
3. **Alternating Roles**: Human and AI messages must strictly alternate (this library handles this via the Graph state, but system message placement is the most common failure point).

In a Multi-Agent system with LangGraph, the `state.messages` accumulates history. Prepending a node-specific system prompt in every turn leads to:
- Multiple system messages.
- System messages appearing after the first position in subsequent graph iterations.

## The Solution: `prepareMessagesForLlm`

We implemented a centralized utility in `src/core/agent/graph/utils.ts` that ensures every LLM invocation is compliant.

### Implementation Details

```typescript
export function prepareMessagesForLlm(
  currentSystemPrompt: SystemMessage,
  history: BaseMessage[]
): BaseMessage[] {
  // 1. Filter out all existing SystemMessages from the state history
  const nonSystemHistory = history.filter((msg) => msg._getType() !== "system");
  
  // 2. Prepend the NEW system prompt (the current agent's role) at index 0
  return [currentSystemPrompt, ...nonSystemHistory];
}
```

### Benefits

1. **Vertex AI Compliance**: Eliminates the "System messages are only permitted as the first passed message" error.
2. **Role Clarity**: Each specialist agent (Researcher, Coder, Supervisor) explicitly overrides the top-level system behavior with its own specific instructions, ensuring the LLM acts according to its current node, ignoring previous outdated system prompts.
3. **Recursion Safety**: Prevents infinite error loops within the graph by ensuring valid payloads are sent to the API on every retry/loop.

## Usage in Graph Nodes

All agent nodes (Supervisor, Researcher, Coder) must use this utility:

```typescript
const response = await model.invoke(prepareMessagesForLlm(sysPrompt, state.messages));
```
