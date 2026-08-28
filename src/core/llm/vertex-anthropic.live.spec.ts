import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { LLMProvider } from './provider';

const describeLive = process.env.RUN_VERTEX_CLAUDE_LIVE === '1'
  ? describe
  : describe.skip;

describeLive('Claude on Vertex AI live tool cycle', () => {
  jest.setTimeout(60_000);

  it('completes one tool round-trip with exactly two model requests', async () => {
    const lookupFixture = tool(
      async ({ key }) => `fixture-ok:${key}`,
      {
        name: 'lookup_fixture',
        description: 'Returns a harmless synthetic fixture value for transport validation.',
        schema: z.object({ key: z.string() }),
      },
    );
    const model = LLMProvider.createChatModel(
      'vertex-anthropic:claude-haiku-4-5@20251001',
      0,
    );
    if (!model.bindTools) {
      throw new Error('The configured Claude model does not support tool binding.');
    }
    const human = new HumanMessage(
      'Call lookup_fixture exactly once with key transport-check. Do not answer before the tool result.',
    );

    const first = await invokeLiveRequest('tool request', () => model.bindTools!(
      [lookupFixture],
      { tool_choice: 'lookup_fixture' },
    ).invoke([human]));

    if (!AIMessage.isInstance(first)) {
      throw new Error('The first Claude response was not an AI message.');
    }
    const toolCall = first.tool_calls?.[0];
    if (!toolCall?.id) {
      throw new Error('Claude did not return the required tool call identifier.');
    }
    const toolCallId = toolCall.id;
    expect(first.tool_calls).toHaveLength(1);
    expect(toolCall.name).toBe('lookup_fixture');

    const key = toolCall.args.key;
    if (typeof key !== 'string') {
      throw new Error('Claude returned a non-string fixture key.');
    }
    const toolResult = `fixture-ok:${key}`;
    const second = await invokeLiveRequest('tool result', () => model.bindTools!([lookupFixture]).invoke([
        human,
        first,
        new ToolMessage({
          content: toolResult,
          tool_call_id: toolCallId,
        }),
      ]));

    if (!AIMessage.isInstance(second)) {
      throw new Error('The final Claude response was not an AI message.');
    }
    expect(second.tool_calls ?? []).toHaveLength(0);
    expect(stringifyMessageContent(second.content)).toContain('fixture-ok:transport-check');
  });
});

/** Converts a LangChain message body into assertion-safe text without assumptions. */
function stringifyMessageContent(content: AIMessage['content']): string {
  return typeof content === 'string' ? content : JSON.stringify(content);
}

/** Runs one billable request while keeping provider payloads out of test output. */
async function invokeLiveRequest<T>(stage: string, request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (error) {
    const status = readSafeStatus(error);
    throw new Error(`Claude Vertex ${stage} failed${status ? ` with status ${status}` : ''}.`);
  }
}

/** Extracts only a numeric provider status, never a URL, payload, or credential. */
function readSafeStatus(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error)) {
    return undefined;
  }
  const status = error.status;
  return typeof status === 'number' || typeof status === 'string'
    ? String(status)
    : undefined;
}
