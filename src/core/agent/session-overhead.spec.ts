import { z } from 'zod';
import {
  clearSessionOverhead,
  recordSessionOverhead,
  sessionOverhead,
  toCountableTool,
} from './session-overhead';

describe('toCountableTool', () => {
  it('converts a zod schema to the JSON Schema the provider is actually sent', () => {
    const countable = toCountableTool({
      name: 'safe_read_file',
      description: 'READS code from the REAL local disk.',
      schema: z.object({ file_path: z.string().describe('Relative path') }),
    });

    const serialized = JSON.stringify(countable.schema);

    expect(countable.name).toBe('safe_read_file');
    // Counting the zod instance would count its internal representation, which
    // is a different and larger number than the wire format.
    expect(serialized).toContain('"type":"object"');
    expect(serialized).toContain('"file_path"');
    expect(serialized).not.toContain('"def"');
  });

  it('keeps a non-zod schema rather than dropping its cost', () => {
    const countable = toCountableTool({ name: 'raw', schema: { type: 'object' } });

    expect(countable.schema).toEqual({ type: 'object' });
  });

  it('tolerates a tool with no description or schema', () => {
    expect(toCountableTool({ name: 'bare' })).toEqual({
      name: 'bare',
      description: undefined,
      schema: undefined,
    });
  });
});

describe('sessionOverhead', () => {
  afterEach(() => clearSessionOverhead());

  it('is empty before an agent is built, so an early caller counts the conversation alone', () => {
    clearSessionOverhead();
    expect(sessionOverhead()).toEqual({});
  });

  it('records what every request in the session pays', () => {
    recordSessionOverhead('You are Umbra.', [
      { name: 'ask_codebase', description: 'Answers about the repo.', schema: z.object({}) },
    ]);

    const recorded = sessionOverhead();

    expect(recorded.system).toBe('You are Umbra.');
    expect(recorded.tools).toHaveLength(1);
    expect(recorded.tools?.[0].name).toBe('ask_codebase');
  });

  it('is overwritten by a later construction, because that catalog is the one being charged', () => {
    recordSessionOverhead('first', [{ name: 'a' }]);
    recordSessionOverhead('second', [{ name: 'b' }, { name: 'c' }]);

    expect(sessionOverhead().system).toBe('second');
    expect(sessionOverhead().tools).toHaveLength(2);
  });
});
