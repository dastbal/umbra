import { FakeToolCallingModel, tool } from 'langchain';
import { z } from 'zod';
import type { SubAgent } from 'deepagents';
import { buildSubagentGraphs, composeSubagentMiddleware, declaredToolNames } from './subagent-registry';
import { createSubagentBudgetMiddleware } from './subagent-budget.middleware';

const readOnlyTool = tool(async () => 'read', {
  name: 'safe_read_file',
  description: 'Read a file.',
  schema: z.object({ file_path: z.string() }),
});

function spec(name: string, overrides: Partial<SubAgent> = {}): SubAgent {
  return {
    name,
    description: `The ${name}.`,
    systemPrompt: `You are the ${name}.`,
    tools: [readOnlyTool] as never,
    model: new FakeToolCallingModel({ toolCalls: [[]] }) as never,
    ...overrides,
  };
}

const specs = {
  researcher: spec('researcher'),
  coder: spec('coder'),
  verifier: spec('verifier'),
};

describe('buildSubagentGraphs', () => {
  it('compiles one delegate per role of the lifecycle', () => {
    const graphs = buildSubagentGraphs(specs);

    expect(Object.keys(graphs).sort()).toEqual(['coder', 'researcher', 'verifier']);
    for (const graph of Object.values(graphs)) {
      expect(typeof graph.invoke).toBe('function');
    }
  });

  it('produces a delegate that runs', async () => {
    const graphs = buildSubagentGraphs(specs);

    const result = await graphs.researcher.invoke({
      messages: [{ role: 'human', content: 'your order' }],
    }) as { messages: unknown[] };

    expect(result.messages.length).toBeGreaterThan(0);
  });

});

describe('composeSubagentMiddleware', () => {
  it('holds every delegate to the budget its order granted', () => {
    // The middleware is what makes the shared turn budget reach a graph that
    // runs with its own fresh recursion allowance.
    for (const role of Object.values(specs)) {
      const names = composeSubagentMiddleware(role).map((one) => one.name);
      expect(names).toContain('SubagentBudget');
    }
  });

  it('does not charge a delegate twice when its specification already carries the budget', () => {
    // Two budget middlewares would consume one grant per attempt each, and a
    // delegate would run out at half of what it was told it had.
    const carried = spec('researcher', { middleware: [createSubagentBudgetMiddleware()] as never });

    const budgets = composeSubagentMiddleware(carried)
      .filter((one) => one.name === 'SubagentBudget');

    expect(budgets).toHaveLength(1);
  });

  it('keeps whatever else the specification declared', () => {
    const custom = spec('coder', { middleware: [{ name: 'Custom' }] as never });

    expect(composeSubagentMiddleware(custom).map((one) => one.name))
      .toEqual(['Custom', 'SubagentBudget']);
  });
});

describe('declaredToolNames', () => {
  it('is the single place a delegate tool list comes from', () => {
    // The defect this closes: deepagents' filesystem middleware handed every
    // subagent tools the harness profile had excluded, and a Coder reaching for
    // read_file instead of safe_read_file ended the delegation. The exclusion
    // never followed, because the list was assembled in a second place.
    expect(declaredToolNames(specs.coder)).not.toContain('read_file');
  });

  it('reports what a specification declares', () => {
    expect(declaredToolNames(specs.researcher)).toEqual(['safe_read_file']);
  });

  it('reports nothing for a specification that declares no tools', () => {
    expect(declaredToolNames(spec('mute', { tools: undefined }))).toEqual([]);
  });
});
