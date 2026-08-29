import { AIMessage, AIMessageChunk, ToolMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import { ChatVertexAI } from '@langchain/google-vertexai';
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

/** The reasoning and the answer as Gemini actually returned them, separately. */
const REASONING = 'Okay, so the user started with "hola." My internal protocol, '
  + 'the CONVERSATION GATE, clearly states that I should keep this brief.';
const ANSWER = 'Hola, soy un agente de IA que te ayuda con NestJS.';

/** A Gemini turn as `responseToChatResult` builds it: two typed blocks. */
function geminiTurn(blocks: unknown[]): ChatResult {
  return {
    generations: [{
      // `text` is the fused string the library would have emitted as the token.
      text: blocks.map((b) => (b as { text?: string; reasoning?: string }).text
        ?? (b as { reasoning?: string }).reasoning ?? '').join(''),
      message: new AIMessageChunk({ content: blocks as never }),
    }],
  };
}

/** A run manager recording only what this override is responsible for. */
function fakeRunManager(): CallbackManagerForLLMRun & {
  tokens: string[];
  customEvents: string[];
} {
  const manager = {
    tokens: [] as string[],
    customEvents: [] as string[],
    handleLLMNewToken: jest.fn(async function (this: { tokens: string[] }, token: string) {
      this.tokens.push(token);
    }),
    handleCustomEvent: jest.fn(async function (this: { customEvents: string[] }, name: string) {
      this.customEvents.push(name);
    }),
  };

  return manager as unknown as CallbackManagerForLLMRun & {
    tokens: string[];
    customEvents: string[];
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

  describe('streaming only the visible half of a turn', () => {
    // The unrecorded consequence of ADR-006. With `disableStreaming = true`,
    // `@langchain/google-common` ends its non-streaming `_generate` with
    // `handleLLMNewToken(chunk.text)` (chat_models.cjs:167) — the flat text,
    // reasoning and answer fused, with no structured chunk beside it. The
    // event tracer then synthesises the turn's only `on_chat_model_stream`
    // from that string, which no downstream reader can un-fuse.
    const TURN = geminiTurn([
      { type: 'reasoning', reasoning: REASONING },
      { type: 'text', text: ANSWER },
    ]);

    let model: VertexChatAdapter;
    let libraryToken: string | undefined;

    beforeEach(() => {
      libraryToken = undefined;
      jest.spyOn(ChatVertexAI.prototype, '_generate').mockImplementation(
        async (_messages, _options, runManager) => {
          // Reproduce the library's own emission, against whatever manager it
          // was handed. Verified verbatim against `chat_models.cjs:167`.
          await runManager?.handleLLMNewToken(TURN.generations[0].text);
          libraryToken = TURN.generations[0].text;
          return TURN;
        },
      );

      model = new VertexChatAdapter({ model: 'gemini-2.5-flash-lite', location: 'global' });
    });

    afterEach(() => jest.restoreAllMocks());

    it('emits the answer and never the reasoning', async () => {
      const runManager = fakeRunManager();

      await model._generate([], {} as never, runManager);

      expect(runManager.tokens).toEqual([ANSWER]);
      expect(runManager.tokens.join('')).not.toContain('CONVERSATION GATE');
    });

    it('silences the library emission that fused the two halves', async () => {
      const runManager = fakeRunManager();

      await model._generate([], {} as never, runManager);

      // The library did emit — into the silenced delegate, not the real manager.
      expect(libraryToken).toContain(REASONING);
      expect(runManager.tokens).not.toContain(libraryToken);
    });

    it('leaves every other callback reaching the real run manager', async () => {
      // Silencing the whole manager would have traded a rendering defect for an
      // observability one: the Vertex connection raises its request and response
      // events through this same object.
      const runManager = fakeRunManager();
      jest.spyOn(ChatVertexAI.prototype, '_generate').mockImplementation(
        async (_messages, _options, inner) => {
          await inner?.handleCustomEvent('google-request-ChatVertexAI', {});
          return TURN;
        },
      );

      await model._generate([], {} as never, runManager);

      expect(runManager.customEvents).toEqual(['google-request-ChatVertexAI']);
    });

    it('returns the provider result untouched, reasoning included', async () => {
      // Only what is rendered as it arrives changes. `on_chat_model_end`, the
      // checkpointer, the trace and the token accounting must still see exactly
      // what the provider returned.
      const result = await model._generate([], {} as never, fakeRunManager());

      expect(result).toBe(TURN);
      expect(result.generations[0].message.content).toContainEqual(
        { type: 'reasoning', reasoning: REASONING },
      );
    });

    it('emits nothing for a turn that carried only reasoning', async () => {
      jest.spyOn(ChatVertexAI.prototype, '_generate').mockResolvedValue(
        geminiTurn([{ type: 'reasoning', reasoning: REASONING }]),
      );
      const runManager = fakeRunManager();

      await model._generate([], {} as never, runManager);

      expect(runManager.tokens).toEqual([]);
    });

    it('delegates unchanged when the run has no callback manager', async () => {
      const generate = jest.spyOn(ChatVertexAI.prototype, '_generate')
        .mockResolvedValue(TURN);

      await expect(model._generate([], {} as never, undefined)).resolves.toBe(TURN);
      expect(generate).toHaveBeenCalledWith([], {}, undefined);
    });
  });
});
