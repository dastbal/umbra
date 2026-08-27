jest.mock('deepagents', () => ({
  createDeepAgent: jest.fn(),
  registerHarnessProfile: jest.fn(),
}));

jest.mock('../llm/provider', () => ({
  LLMProvider: { createChatModel: jest.fn((model: string) => ({ model })) },
}));

import * as tools from '../tools';
import { DeepAgentFactory } from './deep-agent-factory';
import { researcherSubAgent } from '../subagents/researcher.subagent';
import { coderSubAgent } from '../subagents/coder.subagent';
import { verifierSubAgent } from '../subagents/verifier.subagent';

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

/**
 * The same check, applied where nobody was looking.
 *
 * `docs/deferred-work.md` recorded the gap under *"Harness tool exclusions
 * never reach the subagents"*, in a sentence worth repeating: **the set of
 * tools a model can call is assembled in more than one place, and only one of
 * those places is verified.** The check above verifies the `simple` agent. A
 * subagent is a separate graph with its own declarations, and until now nothing
 * checked what its prompt promised against what it holds.
 *
 * This closes the direction that matters — a prompt instructing a delegate to
 * call something it does not have. It does not close the opposite direction,
 * where deepagents' own middleware hands a subagent a tool nobody declared;
 * that needs a runtime observation and stays recorded as deferred work.
 */
describe('a subagent prompt only names tools that subagent declares', () => {
  const SUBAGENTS = [researcherSubAgent, coderSubAgent, verifierSubAgent];

  /**
   * Reports whether a prompt names a tool in order to forbid it.
   *
   * A prohibition and an instruction look identical to a regex, which is why
   * the check above is scoped to one mode. Rather than excusing such a mention
   * with an exception list — five entries is how a guard becomes decoration —
   * this demands the prohibiting form itself. The Coder is told to use
   * safe_write_file "(not write_file)" precisely because deepagents contributes
   * write_file and it breaks on Windows paths; deleting that sentence to satisfy
   * a test would remove a real safeguard.
   */
  const forbiddenInPrompt = (prompt: string, name: string): boolean =>
    new RegExp('\\bnot\\s+`?' + name + '\\b').test(prompt);

  it.each(SUBAGENTS.map((subagent) => [subagent.name, subagent] as const))(
    'the %s prompt advertises nothing it cannot call',
    (_name, subagent) => {
      const declared = [
        ...(subagent.tools ?? []).map((tool) => (tool as { name: string }).name),
        // deepagents contributes the todo list to every subagent.
        'write_todos',
      ];
      const undeclared = toolsNamedIn(subagent.systemPrompt)
        .filter((name) => !declared.includes(name))
        .filter((name) => !forbiddenInPrompt(subagent.systemPrompt, name));

      expect(undeclared).toEqual([]);
    },
  );

  it.each(SUBAGENTS.map((subagent) => [subagent.name, subagent] as const))(
    'the %s can ask about its own order instead of guessing',
    (_name, subagent) => {
      const declared = (subagent.tools ?? []).map((tool) => (tool as { name: string }).name);

      expect(declared).toContain('ask_delegator');
      expect(subagent.systemPrompt).toContain('ask_delegator');
    },
  );

  it.each(SUBAGENTS.map((subagent) => [subagent.name, subagent] as const))(
    'the %s is held to the budget its order granted',
    (_name, subagent) => {
      expect(subagent.middleware?.some((one) => one.name === 'SubagentBudget')).toBe(true);
    },
  );

  it('lets the agent that writes code consult the decision records', () => {
    // list_adrs was declared only by the Researcher, so the Coder wrote into a
    // project whose recorded decisions it could not read — including a consumer
    // project that received docs/adr/ from `umbra init`.
    const coderTools = (coderSubAgent.tools ?? []).map((tool) => (tool as { name: string }).name);

    expect(coderTools).toContain('list_adrs');
  });
});
