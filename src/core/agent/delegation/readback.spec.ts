import { FakeToolCallingModel, tool } from 'langchain';
import { z } from 'zod';
import type { SubAgent } from 'deepagents';
import {
  asReadbackOrder,
  buildReadbackGraph,
  parseReadback,
  renderReadback,
} from './readback';

const spec: SubAgent = {
  name: 'researcher',
  description: 'The researcher.',
  systemPrompt: 'You are the researcher.',
  tools: [tool(async () => 'read', {
    name: 'safe_read_file',
    description: 'Read a file.',
    schema: z.object({ file_path: z.string() }),
  })] as never,
  model: new FakeToolCallingModel({ toolCalls: [[]] }) as never,
};

describe('asReadbackOrder', () => {
  it('reads back the order that will actually be carried out', () => {
    // A readback of different text proves nothing about the order in force, so
    // the instruction is appended rather than replacing it.
    const order = '## Your objective\n\nReview the shipped skills';

    expect(asReadbackOrder(order)).toContain(order);
    expect(asReadbackOrder(order)).toContain('read this order back');
  });

  it('tells the delegate not to start yet', () => {
    expect(asReadbackOrder('order')).toContain('Do not carry out any of the work above yet');
  });
});

describe('buildReadbackGraph', () => {
  it('gives the reader no tools, so describing cannot become doing', () => {
    // A delegate asked to describe its plan while holding the tools to execute
    // it may simply begin. One holding nothing can only answer, and that is a
    // structural guarantee rather than a request in a prompt.
    const graph = buildReadbackGraph(spec) as unknown as { tools?: unknown[] };

    expect(graph.tools ?? []).toHaveLength(0);
  });

  it('produces a reader that runs', async () => {
    const result = await buildReadbackGraph(spec).invoke({
      messages: [{ role: 'human', content: asReadbackOrder('your order') }],
    }) as { messages: unknown[] };

    expect(result.messages.length).toBeGreaterThan(0);
  });
});

describe('parseReadback', () => {
  it('reads the structured understanding a delegate returned', () => {
    const understanding = {
      objective: 'Review each markdown guide under skills/.',
      outOfScope: 'The general architecture.',
      firstAction: 'list_files("skills/")',
    };

    expect(parseReadback({ structuredResponse: understanding })).toEqual(understanding);
  });

  it('keeps a prose answer rather than discarding what the delegate said', () => {
    const readback = parseReadback({ messages: [{ content: 'I will review the six guides.' }] });

    expect(readback?.objective).toBe('I will review the six guides.');
    expect(readback?.firstAction).toBe('not stated');
  });

  it('reports nothing readable rather than inventing an understanding', () => {
    // A readback that cannot be read must never pass silently: the operator has
    // to see that the check did not happen.
    expect(parseReadback({ messages: [] })).toBeUndefined();
    expect(parseReadback({ messages: [{ content: '   ' }] })).toBeUndefined();
    expect(parseReadback(undefined)).toBeUndefined();
  });
});

describe('renderReadback', () => {
  const understanding = {
    objective: 'Review each markdown guide under skills/.',
    outOfScope: 'The general architecture, which is settled.',
    firstAction: 'list_files("skills/")',
  };

  it('shows what was understood and what will happen first', () => {
    const line = renderReadback('researcher', understanding);

    expect(line).toContain('researcher entendió');
    expect(line).toContain('Review each markdown guide');
    expect(line).toContain('Primera acción: list_files("skills/")');
  });

  it('names the boundary the delegate believes it has', () => {
    expect(renderReadback('coder', understanding)).toContain('fuera: The general architecture');
  });

  it('does not print a boundary the order never gave', () => {
    const line = renderReadback('coder', { ...understanding, outOfScope: 'nothing stated' });

    expect(line).not.toContain('fuera:');
  });
});
