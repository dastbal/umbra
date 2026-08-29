jest.mock('deepagents', () => ({
  createDeepAgent: jest.fn(),
  registerHarnessProfile: jest.fn(),
}));

jest.mock('../llm/provider', () => ({
  LLMProvider: { createChatModel: jest.fn((model: string) => ({ model })) },
}));

import * as tools from '../tools';
import { DeepAgentFactory } from './deep-agent-factory';
import { resolveCapabilityTools, type AgentCapability } from './agent-kernel';
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

/**
 * Reports whether a prompt names a tool only in order to forbid it.
 *
 * A prohibition and an instruction look identical to a regex, which is why this
 * check needs one and why the exception is a *shape* rather than a list. Two
 * mentions in this codebase are real prohibitions and must survive: the Coder is
 * told to use `safe_write_file` "(not write_file)" because deepagents
 * contributes a `write_file` that breaks on Windows paths, and every mode is
 * told that "Attempting to `safe_write_file` to these paths is FORBIDDEN",
 * which protects `skills/*.md` and `AGENTS.md` from the agent that can write.
 *
 * Deleting either sentence to satisfy a test would remove a real safeguard, and
 * excusing them by name would grow the list that turns a guard into decoration.
 * So the sentence containing the mention has to read as a prohibition.
 *
 * Scoped to the sentence, never the whole prompt: a document that says "never"
 * somewhere would otherwise excuse every tool it advertises.
 */
function forbiddenInPrompt(prompt: string, name: string): boolean {
  // Word-bounded, so `safe_write_file` is not read as a mention of `write_file`.
  const mentions = new RegExp(`\\b${name}\\b`);
  const sentences = prompt.split(/(?<=[.!?])\s+|\n/);

  return sentences
    .filter((sentence) => mentions.test(sentence))
    .every((sentence) => /\bnot\b|\bnever\b|\bforbidden\b/i.test(sentence));
}

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
    // If the delegation tool ever leaves this prompt the routing instructions
    // are dead text; if it leaves the declarations, ADR-013 happens again.
    expect(internals.buildSystemPrompt('C:\project', 'orchestrator')).toContain('delegate');
  });

  it('no longer routes the orchestrator through the deepagents task tool', () => {
    // The orchestrator declares `delegate` and excludes `task`. A prompt still
    // ordering a `task` call would instruct a tool the model cannot see — the
    // defect ADR-013 recorded, in the opposite direction.
    const prompt = internals.buildSystemPrompt('C:\project', 'orchestrator');

    expect(prompt).not.toMatch(new RegExp('`task`|\\btask\\('));
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

/**
 * The same check, aimed where the defect actually happened.
 *
 * On 2026-08-28 the orchestrator was asked to review the project's decision
 * records. Its prompt said *"call `list_adrs` first"*; its capability profile
 * granted `search_codebase`, `verify_integrity`, `delegate` and
 * `escalate_route`, and nothing else. The model spent most of its reasoning
 * reconciling an order it could not obey, searched the code instead, and then
 * delivered architecture conclusions inferred from two source files it happened
 * to find.
 *
 * That is ADR-013's defect exactly — a prompt naming a tool the mode does not
 * declare — and the test written to prevent it never looked here, because it was
 * scoped to the `simple` agent while this prompt was left to inheritance.
 *
 * The capability list is the authority now, so the check reads the profile
 * rather than a list retyped in a test. A capability added to the Supervisor
 * widens what its prompt may name, with no edit here.
 */
describe('the orchestrator prompt only names tools its profile grants', () => {
  const internals = DeepAgentFactory as unknown as {
    buildSystemPrompt(rootDir: string, type: 'simple' | 'orchestrator' | 'analysis'): string;
    createSupervisorRoleProfile(): { capabilities: readonly AgentCapability[] };
  };

  /** Tool names the Supervisor's own capabilities resolve to, plus the harness todo list. */
  const supervisorDeclares = (): string[] => [
    ...resolveCapabilityTools(internals.createSupervisorRoleProfile().capabilities, {
      delegateTool: { name: 'delegate' } as never,
      escalateRouteTool: { name: 'escalate_route' } as never,
    }).map((one) => (one as { name: string }).name),
    'write_todos',
  ];

  it('advertises nothing the Supervisor cannot call', () => {
    const declared = supervisorDeclares();
    const prompt = internals.buildSystemPrompt('C:\\project', 'orchestrator');
    const undeclared = toolsNamedIn(prompt)
      .filter((name) => !forbiddenInPrompt(prompt, name))
      .filter((name) => !declared.includes(name));

    expect(undeclared).toEqual([]);
  });

  it('can still name the ADR index, which is the capability that was missing', () => {
    // Consulting the decision index is read-only and cheap. The prompt asks for
    // it, so the profile has to grant it — this is the pair that broke.
    expect(supervisorDeclares()).toContain('list_adrs');
    expect(internals.buildSystemPrompt('C:\\project', 'orchestrator')).toContain('list_adrs');
  });

  it('names enough tools that the check cannot pass vacuously', () => {
    expect(toolsNamedIn(internals.buildSystemPrompt('C:\\project', 'orchestrator')).length)
      .toBeGreaterThan(2);
  });
});
