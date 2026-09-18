import { randomUUID } from 'crypto';
import { HumanMessage } from '@langchain/core/messages';
import { DeepAgentFactory } from '../../core/agent/deep-agent-factory';

/** A compiled graph surface needed by the persistent MCP conversation adapter. */
interface McpConversationAgent {
  invoke(input: { messages: HumanMessage[] }, config: { configurable: { thread_id: string } }): Promise<unknown>;
}

/** The one answer returned after a conversation turn. */
export interface McpConversationTurn {
  readonly conversationId: string;
  readonly answer: string;
}

/** Creates a read-only graph for one opaque conversation identifier. */
export type McpConversationAgentFactory = (rootDir: string, threadId: string) => Promise<McpConversationAgent>;

/**
 * Continues a repository conversation from LangGraph's SQLite checkpoint.
 *
 * The UUID is intentionally opaque rather than a user supplied label: a caller
 * can resume only a value Umbra issued, and the fixed MCP root namespaces the
 * underlying checkpoint. The in-memory map is merely a warm-process cache; a
 * restarted server reconstructs the same graph against the durable checkpoint.
 */
export class McpConversationService {
  private readonly agents = new Map<string, McpConversationAgent>();

  /** @param createAgent - Injectable graph factory used by the production adapter and tests. */
  public constructor(private readonly createAgent: McpConversationAgentFactory = defaultAgentFactory) {}

  /**
   * Starts or resumes one read-only conversation.
   *
   * @param rootDir - Validated and pinned repository root.
   * @param message - The user's next message.
   * @param requestedConversationId - Opaque receipt from a prior turn, if any.
   * @returns The stable receipt plus the advisor's visible answer.
   */
  public async continue(
    rootDir: string,
    message: string,
    requestedConversationId?: string,
  ): Promise<McpConversationTurn> {
    const conversationId = requestedConversationId === undefined
      ? randomUUID()
      : validateConversationId(requestedConversationId);
    const threadId = `mcp-${conversationId}`;
    const cacheKey = `${rootDir}\u0000${conversationId}`;
    let agent = this.agents.get(cacheKey);
    if (agent === undefined) {
      agent = await this.createAgent(rootDir, threadId);
      this.agents.set(cacheKey, agent);
    }

    const result = await agent.invoke(
      { messages: [new HumanMessage(message)] },
      { configurable: { thread_id: threadId } },
    );
    return { conversationId, answer: readVisibleAnswer(result) };
  }
}

async function defaultAgentFactory(rootDir: string, threadId: string): Promise<McpConversationAgent> {
  return DeepAgentFactory.createMcpAdvisor({ rootDir, threadId }) as Promise<McpConversationAgent>;
}

function validateConversationId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error('conversationId must be an Umbra-issued UUID receipt.');
  }
  return value.toLowerCase();
}

function readVisibleAnswer(result: unknown): string {
  if (!isRecord(result) || !Array.isArray(result['messages'])) {
    throw new Error('The MCP advisor completed without a message result.');
  }
  const last = [...result['messages']].reverse().find(isRecord);
  const content = last?.['content'];
  if (typeof content === 'string' && content.trim().length > 0) return content;
  if (Array.isArray(content)) {
    const text = content
      .filter(isRecord)
      .map((part) => typeof part['text'] === 'string' ? part['text'] : '')
      .filter(Boolean)
      .join('\n');
    if (text.trim().length > 0) return text;
  }
  throw new Error('The MCP advisor completed without visible answer text.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
