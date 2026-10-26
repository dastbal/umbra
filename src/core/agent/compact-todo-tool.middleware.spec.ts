import { z } from 'zod';
import {
  FakeToolCallingModel,
  createAgent,
  createMiddleware,
  todoListMiddleware,
  tool,
} from 'langchain';
import { COMPACT_WRITE_TODOS_DESCRIPTION } from './compact-todo-tool.middleware';

/**
 * These drive a real `createAgent`, not a mock.
 *
 * Every unit test that builds a deep agent mocks `deepagents`, so none of them
 * sees what the model is actually bound with. LangChain itself is not mocked
 * here: the todo middleware is the one `DeepAgentFactory` installs, configured
 * the way it configures it, and `AgentNode` runs its checks for real.
 */
describe('todoListMiddleware as DeepAgentFactory installs it', () => {
  /** Descriptions the model was actually bound with, by tool name. */
  let bound: Map<string, string>;

  beforeEach(() => {
    bound = new Map();
    const original = FakeToolCallingModel.prototype.bindTools;
    jest.spyOn(FakeToolCallingModel.prototype, 'bindTools').mockImplementation(function (this: FakeToolCallingModel, tools) {
      for (const one of tools) bound.set(one.name, one.description);
      return original.call(this, tools);
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const echo = tool(async () => 'ok', {
    name: 'echo',
    description: 'Returns ok. Present so a tool other than write_todos is in the request.',
    schema: z.object({}),
  });

  /** The configuration the factory uses for the deep agent and the orchestrator. */
  const installed = () => todoListMiddleware({ toolDescription: COMPACT_WRITE_TODOS_DESCRIPTION });

  /** Builds and runs one turn of a real agent with the given middleware. */
  async function runTurn(middleware: unknown[]): Promise<void> {
    const agent = createAgent({
      model: new FakeToolCallingModel({ toolCalls: [[]] }) as never,
      tools: [echo] as never,
      middleware: middleware as never,
    });
    await agent.invoke({ messages: [{ role: 'user', content: 'plan the work' }] } as never);
  }

  it('binds the model with the compact description', async () => {
    await runTurn([installed()]);

    expect(bound.get('write_todos')).toBe(COMPACT_WRITE_TODOS_DESCRIPTION);
  });

  it('leaves every other tool exactly as it was declared', async () => {
    await runTurn([installed()]);

    expect(bound.get('echo')).toBe(echo.description);
  });

  // The description tells the model to send every item because each call
  // replaces the list. That is only honest if the installed tool behaves that
  // way, so this writes twice through a real agent and reads what survived.
  it('describes a tool whose list really is replaced, not merged', async () => {
    const first = [
      { content: 'read the module', status: 'completed' },
      { content: 'write the spec', status: 'in_progress' },
    ];
    const second = [{ content: 'write the spec', status: 'completed' }];

    const agent = createAgent({
      model: new FakeToolCallingModel({
        toolCalls: [
          [{ name: 'write_todos', args: { todos: first }, id: 'call-1' }],
          [{ name: 'write_todos', args: { todos: second }, id: 'call-2' }],
          [],
        ],
      }) as never,
      tools: [] as never,
      middleware: [installed()] as never,
    });

    const state = await agent.invoke({ messages: [{ role: 'user', content: 'plan the work' }] } as never) as { todos?: unknown };

    expect(state.todos).toEqual(second);
  });

  // Pins the library rule that made the previous design necessary: a tool in
  // `wrapModelCall` may be filtered but not replaced by another object of the
  // same name. The native option makes it moot here, but it still binds anyone
  // who reaches for a description-rewriting middleware — and if a future
  // LangChain relaxes it, this fails and says the constraint moved.
  it('documents why descriptions are set at construction: the library refuses a replaced tool', async () => {
    const cloning = createMiddleware({
      name: 'CloningTodoTool',
      wrapModelCall: async (request, handler) => handler({
        ...request,
        tools: request.tools.map((one) => ((one as { name?: unknown }).name === 'write_todos'
          ? Object.assign(Object.create(Object.getPrototypeOf(one)), one, { description: 'cloned' })
          : one)),
      }),
    });

    await expect(runTurn([todoListMiddleware(), cloning])).rejects.toThrow(/modified a tool/);
  });
});

describe('COMPACT_WRITE_TODOS_DESCRIPTION', () => {
  // A compact description that silently loses a rule is a regression that no
  // count would notice. Each of these is a behaviour the model must still know.
  it.each([
    ['the three states', /pending.*in_progress.*completed/s],
    ['that each call replaces the list', /replaces the whole list/],
    ['in_progress before starting', /in_progress before you start/],
    ['completed only when fully done', /Never mark an item completed/],
    ['that a blocker gets its own item', /describes the blocker/],
    ['that completed items stay fixed', /Never change an item that is already completed/],
    ['when not to use it', /Skip it/],
  ])('keeps the rule about %s', (_rule, pattern) => {
    expect(COMPACT_WRITE_TODOS_DESCRIPTION).toMatch(pattern);
  });

  // The library default is 11,389 characters, 66% of it worked examples. This
  // is a ratchet, like module-size-ceiling: the description may shrink, and
  // growing it back past this is a decision to make on purpose.
  it('stays a fraction of the library default', () => {
    expect(COMPACT_WRITE_TODOS_DESCRIPTION.length).toBeLessThan(1_500);
  });
});
