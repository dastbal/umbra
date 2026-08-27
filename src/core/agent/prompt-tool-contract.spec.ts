jest.mock('deepagents', () => ({
  createDeepAgent: jest.fn(),
  registerHarnessProfile: jest.fn(),
}));

jest.mock('../llm/provider', () => ({
  LLMProvider: { createChatModel: jest.fn((model: string) => ({ model })) },
}));

import * as tools from '../tools';
import { DeepAgentFactory } from './deep-agent-factory';

/**
 * Every tool name the codebase knows about, read from the tool objects rather
 * than retyped, so renaming a tool cannot desynchronise this list.
 */
const OWN_TOOL_NAMES = Object.values(tools)
  .map((value) => (typeof value === 'object' && value !== null
    ? (value as { name?: unknown }).name
    : undefined))
  .filter((name): name is string => typeof name === 'string');

/** Tool names deepagents contributes through its own middleware. */
const DEEPAGENTS_TOOL_NAMES = [
  'write_todos', 'task', 'grep', 'glob', 'ls', 'read_file', 'write_file', 'edit_file',
];

const VOCABULARY = [...new Set([...OWN_TOOL_NAMES, ...DEEPAGENTS_TOOL_NAMES])];

/**
 * What `DeepAgentFactory.create()` declares, plus deepagents' own `write_todos`.
 *
 * Membership is stated here; the names come from the tool objects. If a tool is
 * added to `create()` and not added here, this test reports a name the prompt
 * uses as undeclared — noisy, never silent, which is the failure direction that
 * matters.
 */
const SIMPLE_DECLARED = [
  tools.safeWriteFileTool.name,
  tools.safeReadFileTool.name,
  tools.deleteFileTool.name,
  tools.listFilesTool.name,
  tools.listAdrsTool.name,
  tools.askCodebaseTool.name,
  tools.refreshIndexTool.name,
  tools.integrityCheckTool.name,
  tools.executeTestsTool.name,
  'write_todos',
];

/**
 * Tool names that are also ordinary English words.
 *
 * `task` runs through every prompt as a noun — "before every task", "coding
 * tasks" — so only a backticked or called form means the tool.
 */
const AMBIGUOUS_NAMES = new Set(['task']);

/** Returns the tool names a prompt names as tools. */
function toolsNamedIn(prompt: string): string[] {
  return VOCABULARY.filter((name) => {
    if (AMBIGUOUS_NAMES.has(name)) {
      return new RegExp(`\`${name}\`|\\b${name}\\(`).test(prompt);
    }
    return new RegExp(`\\b${name}\\b`).test(prompt);
  });
}

interface FactoryInternals {
  buildSystemPrompt(rootDir: string, type: 'simple' | 'orchestrator' | 'analysis'): string;
}

describe('the deep prompt only names tools the model can actually call', () => {
  const internals = DeepAgentFactory as unknown as FactoryInternals;

  /**
   * The defect this closes, four times over: `delete_file` (ADR-011),
   * `ask_human` (`docs/deferred-work.md`) and `task` (ADR-013) were each
   * instructed in the prompt while unavailable to the model. A model told to
   * call a tool it cannot see invents the call, and the failure then surfaces
   * far from its cause — as `UNEXPECTED_TOOL_CALL`, or as a guard rejecting a
   * subagent the model had actually named correctly.
   *
   * ## Why only the `simple` mode
   * The three modes share one base prompt written for this one. `orchestrator`
   * declares three tools and `analysis` declares none (`tools: []`,
   * manifest-only by design), so both inherit instructions for tools they do
   * not have — and `analysis` also names tools deliberately to *forbid* them,
   * which no textual check can tell apart from an instruction to use one.
   * Scoping those two prompts per mode is a change to what the model reads and
   * is recorded in `docs/deferred-work.md` instead of guessed at here.
   */
  it('does not advertise an undeclared tool', () => {
    const prompt = internals.buildSystemPrompt('C:\\project', 'simple');
    const undeclared = toolsNamedIn(prompt).filter((name) => !SIMPLE_DECLARED.includes(name));

    expect(undeclared).toEqual([]);
  });

  it('names enough tools that the check cannot pass vacuously', () => {
    const prompt = internals.buildSystemPrompt('C:\\project', 'simple');
    expect(toolsNamedIn(prompt).length).toBeGreaterThan(3);
  });

  it('no longer instructs the model to call ask_human, which no mode registers', () => {
    for (const mode of ['simple', 'orchestrator', 'analysis'] as const) {
      expect(internals.buildSystemPrompt('C:\\project', mode)).not.toContain('ask_human');
    }
  });

  it('keeps the orchestrator prompt naming its delegation tool', () => {
    // If `task` ever leaves this prompt the routing instructions are dead text;
    // if it leaves the declarations, ADR-013 happens again.
    expect(internals.buildSystemPrompt('C:\\project', 'orchestrator')).toContain('task');
  });
});
