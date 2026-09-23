import { z } from 'zod';
import { FakeToolCallingModel, createAgent, tool } from 'langchain';
import { CONTEXT_EDITING, createContextEditingMiddleware } from './context-editing';

/**
 * These drive a real `createAgent` with the real policy — no mocked library, no
 * lowered trigger. The tools return about 12,500 tokens each, so five calls
 * cross `triggerTokens` the way a session reading five large files would.
 */
describe('createContextEditingMiddleware', () => {
  const BIG = 'x'.repeat(50_000);

  /** Tool messages as the model received them on each call, in call order. */
  let seen: Array<Array<{ name?: string; content: string }>>;

  beforeEach(() => {
    seen = [];
    const original = FakeToolCallingModel.prototype._generate;
    jest.spyOn(FakeToolCallingModel.prototype, '_generate').mockImplementation(function (this: FakeToolCallingModel, messages, ...rest) {
      seen.push(messages
        .filter((m) => (m._getType?.() ?? (m as { getType?: () => string }).getType?.()) === 'tool')
        .map((m) => ({ name: (m as { name?: string }).name, content: String(m.content) })));
      return original.call(this, messages, ...rest);
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** A tool that returns a large result, under a chosen name. */
  const large = (name: string) => tool(async () => BIG, {
    name,
    description: 'Returns a large result, like reading a big file.',
    schema: z.object({}),
  });

  /** Runs one turn in which the model calls `name` `times` times, then answers. */
  async function conversation(name: string, times: number): Promise<void> {
    const toolCalls = Array.from({ length: times }, (_, index) => [{ name, args: {}, id: `${name}-${index + 1}` }]);
    const agent = createAgent({
      model: new FakeToolCallingModel({ toolCalls: [...toolCalls, []] }) as never,
      tools: [large(name)] as never,
      middleware: [createContextEditingMiddleware()] as never,
    });
    await agent.invoke({ messages: [{ role: 'user', content: 'read everything' }] } as never);
  }

  const cleared = (call: Array<{ content: string }>) => call.filter((m) => m.content.trim() === '[cleared]').length;

  it('clears nothing while the conversation stays under the trigger', async () => {
    await conversation('safe_read_file', 2);

    expect(seen.every((call) => cleared(call) === 0)).toBe(true);
  });

  it('clears every result but the most recent ones once the trigger is crossed', async () => {
    await conversation('safe_read_file', 5);
    const last = seen[seen.length - 1];

    expect(last).toHaveLength(5);
    expect(cleared(last)).toBeGreaterThan(0);
    // The most recent results are what the current task is working with.
    expect(last.slice(-CONTEXT_EDITING.keepToolResults).every((m) => m.content === BIG)).toBe(true);
  });

  it('keeps what the model is sent bounded instead of growing with every read', async () => {
    await conversation('safe_read_file', 5);
    const payload = (call: Array<{ content: string }>) => call.reduce((sum, m) => sum + m.content.length, 0);

    // Five full results would be 250,000 characters. After clearing, what is
    // sent is the kept results plus placeholders.
    expect(payload(seen[seen.length - 1])).toBeLessThan(5 * BIG.length);
  });

  // The orchestration guard counts each role's results by reading the thread,
  // so a delegation's result must survive however old it is.
  it.each(CONTEXT_EDITING.excludeTools)('never clears a %s result', async (name) => {
    await conversation(name, 5);

    expect(seen.every((call) => cleared(call) === 0)).toBe(true);
  });
});
