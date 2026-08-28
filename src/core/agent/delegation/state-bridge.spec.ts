import {
  SUBAGENT_EXCLUDED_STATE_KEYS,
  toParentUpdate,
  toSubagentState,
} from './state-bridge';

describe('toSubagentState', () => {
  const parentState = {
    messages: [{ content: 'the whole conversation the delegate must not see' }],
    todos: [{ content: 'orchestrator bookkeeping' }],
    files: { 'skills/analyze-codebase.md': '# Analyze' },
    structuredResponse: { status: 'ready' },
  };

  it('replaces the delegate history with its order, never appends to it', () => {
    const state = toSubagentState(parentState, '## Your objective\n\nReview the skills');

    expect(state['messages']).toHaveLength(1);
    expect(String((state['messages'] as { content: unknown }[])[0].content))
      .toContain('Review the skills');
  });

  it('carries the shared workspace across, which is what makes it shared', () => {
    const state = toSubagentState(parentState, 'order');

    expect(state['files']).toEqual({ 'skills/analyze-codebase.md': '# Analyze' });
  });

  it.each(SUBAGENT_EXCLUDED_STATE_KEYS.filter((key) => key !== 'messages'))(
    'does not leak %s into the delegate',
    (key) => {
      expect(toSubagentState(parentState, 'order')[key]).toBeUndefined();
    },
  );

  it('works from a parent with no state at all', () => {
    expect(Object.keys(toSubagentState(undefined, 'order'))).toEqual(['messages']);
  });
});

describe('toParentUpdate', () => {
  it('returns the artifact as the tool result, so the policy can read its status', () => {
    const artifact = { status: 'ready', objective: 'Review the skills', findings: [] };

    const { content } = toParentUpdate({ structuredResponse: artifact, messages: [] });

    expect(JSON.parse(content)).toEqual(artifact);
  });

  it('prefers the artifact over the last message', () => {
    const { content } = toParentUpdate({
      structuredResponse: { status: 'partial' },
      messages: [{ content: 'chatty closing remark' }],
    });

    expect(content).not.toContain('chatty');
  });

  it('falls back to the last message when no artifact was produced', () => {
    expect(toParentUpdate({ messages: [{ content: 'plain answer' }] }).content)
      .toBe('plain answer');
  });

  it('drops blocks a provider rejects inside a tool result', () => {
    // Sending one back is a provider rejection this project already paid for.
    const { content } = toParentUpdate({
      messages: [{
        content: [
          { type: 'thinking', thinking: 'internal' },
          { type: 'text', text: 'the visible answer' },
        ],
      }],
    });

    expect(content).toBe('the visible answer');
    expect(content).not.toContain('internal');
  });

  it('merges the workspace back into the orchestrator', () => {
    const { update } = toParentUpdate({
      files: { 'src/new.ts': 'export const x = 1;' },
      messages: [{ content: 'done' }],
    });

    expect(update).toEqual({ files: { 'src/new.ts': 'export const x = 1;' } });
  });

  it('does not merge the delegate messages or artifact into the parent state', () => {
    const { update } = toParentUpdate({
      messages: [{ content: 'done' }],
      structuredResponse: { status: 'ready' },
      todos: [{ content: 'delegate bookkeeping' }],
    });

    expect(update).toEqual({});
  });

  it('never returns an empty tool result', () => {
    expect(toParentUpdate({}).content).toBe('Task completed');
    expect(toParentUpdate({ messages: [{ content: '   ' }] }).content).toBe('Task completed');
    expect(toParentUpdate({ messages: [{ content: [{ type: 'thinking' }] }] }).content)
      .toBe('Task completed');
  });

  it('survives an artifact that cannot be serialized', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;

    expect(toParentUpdate({ structuredResponse: circular }).content).toBe('Task completed');
  });
});
