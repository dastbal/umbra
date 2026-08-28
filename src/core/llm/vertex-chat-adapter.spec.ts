import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { VertexChatAdapter } from './vertex-chat-adapter';

interface VertexChatAdapterInternals {
  connection: {
    api: {
      baseMessageToContent?(
        message: unknown,
        previousMessage: unknown,
      ): Promise<Array<{ role: string }>>;
    };
  };
}

describe('VertexChatAdapter', () => {
  it('exposes the Google provider identity required by deepagents harness profiles', () => {
    const model = new VertexChatAdapter({
      model: 'gemini-3.5-flash',
      location: 'global',
    });

    expect(model.getName()).toBe('ChatGoogleGenerativeAI');
    expect(model.disableStreaming).toBe(true);
  });

  it('serializes tool responses with the user role required by Gemini 3.5', async () => {
    const model = new VertexChatAdapter({
      model: 'gemini-3.5-flash',
      location: 'global',
    });
    const internals = model as unknown as VertexChatAdapterInternals;
    const convert = internals.connection.api.baseMessageToContent;

    expect(convert).toBeDefined();

    const content = await convert?.(
      new ToolMessage({ content: '{"result":"ok"}', tool_call_id: 'call-1' }),
      new AIMessage({
        content: '',
        tool_calls: [{ name: 'ask_codebase', args: {}, id: 'call-1' }],
      }),
    );

    expect(content?.[0]?.role).toBe('user');
  });
});
