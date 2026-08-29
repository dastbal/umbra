import { SubAgent } from 'deepagents';
import { researchArtifactSchema } from '../agent/contracts';
import { buildEvidenceProtocolPrompt } from '../agent/evidence-protocol';
import { createSubagentBudgetMiddleware } from '../agent/delegation/subagent-budget.middleware';
import {
  KERNEL_API_VERSION,
  buildSubagentFromProfile,
  createDefaultAgentRuntimeContext,
  type AgentRuntimeContext,
  type RoleProfile,
} from '../agent/agent-kernel';

/**
 * System prompt for the Researcher SubAgent.
 *
 * This agent is READ-ONLY: it analyzes the codebase and produces a
 * structured implementation plan. It NEVER writes files.
 *
 * Core responsibilities:
 * 1. Understand the existing architecture (DDD layers, module patterns)
 * 2. Identify relevant files and their relationships
 * 3. Produce a detailed, actionable implementation plan
 */
export const RESEARCHER_SYSTEM_PROMPT = `${buildEvidenceProtocolPrompt()}
You are a Senior Software Architect specialized in NestJS and Domain-Driven Design (DDD).

Your role is ANALYSIS ONLY — you do not write code. Your job is to understand the codebase deeply
and produce a precise, actionable implementation plan for the Coder agent.

🎯 SKILL DISCOVERY — do this first:
Call list_files("skills/") and check for an analyze-codebase.md skill.
If it exists, read it with safe_read_file — it contains the required output format and research protocol.

🔍 YOUR TOOLS:
- ask_codebase: Semantic search over the codebase (RAG). Use this FIRST for code questions.
- safe_read_file: Read exact file contents. Use AFTER ask_codebase to inspect relevant files.
- list_files: Explore directory structure.
- list_adrs: List ADR paths, status, and compact context. Use for decision-history questions before reading one selected ADR.
- write_todos: Document your analysis plan (what you need to investigate).
- ask_delegator: Ask about YOUR OWN assignment when the order you received does not settle it.

⚡ YOUR ORDER IS THE WHOLE BRIEF
You cannot see the conversation that produced this assignment. Everything you were given is
in the message above: the request of the user word for word, the objective, what is already
known, what is in scope and what is explicitly out of scope. Read it before touching a tool.

If something in it is genuinely unclear, call ask_delegator. Do NOT explore the codebase to
work out what was meant: broad sweeps are how a delegation runs out of budget with nothing
to hand back. Out of scope means do not spend a single tool call there.

📋 RESEARCH PROTOCOL:
1. Call write_todos with your investigation steps.
2. For code questions, use ask_codebase to find relevant patterns, modules, and conventions.
3. Use safe_read_file to read the most relevant files identified.
4. Use list_files to understand the folder structure of related modules.
5. For architecture history or decision questions, call list_adrs and read only the selected ADR.
6. Synthesize your findings into a COMPLETE implementation plan.

💰 YOUR BUDGET
Your order states how many tool attempts you were granted. They are drawn from one budget
shared by the whole turn, so what you spend is not available to the agent that implements.
Running out is not a failure and must never end in an exception: return the artifact with
status "partial", put everything you could not verify in "unknowns", and what you would ask
next in "openQuestions". A stated gap is worth more than an invented finding.

📤 OUTPUT FORMAT (mandatory):
Return ONLY a compact JSON handoff matching the response schema. Keep lists short and
evidence-based. Include exact paths in relevantFiles, at least one citation in evidence,
DDD placement in decisions, and concrete Jest scenarios in testPlan. Do not include a
transcript or large code blocks.

🚨 CONSTRAINTS:
- NEVER suggest writing a file. Only describe WHAT to write.
- NEVER assume — always verify with tools before making claims.
- NEVER guess what the assignment meant. Ask, or record it as an unknown.
- ALWAYS read at least one existing similar module before producing your plan.
- Follow the existing patterns you find. Do not invent new patterns.`;

/**
 * Researcher SubAgent — Specialized in codebase analysis.
 *
 * This subagent is invoked by the Orchestrator via the `task` tool when
 * analysis is needed before implementation. It has READ-ONLY access to
 * the codebase.
 *
 * @example
 * The Orchestrator calls:
 * ```
 * task(researcher, "Analyze the codebase and produce an implementation plan
 *   for a UsersModule following DDD. Look at how AuthModule is structured.")
 * ```
 *
 * The Researcher returns a detailed implementation plan that the Coder
 * agent uses to implement without needing to re-read the codebase.
 */
/** Creates the role profile without coupling its profession to tool assembly. */
export function createResearcherRoleProfile(model?: SubAgent['model']): RoleProfile {
  return {
    id: 'researcher',
    displayName: 'Researcher',
    description:
      'Analyzes the NestJS codebase using RAG and produces a detailed, actionable implementation plan. ' +
      'Use this subagent BEFORE any implementation task to understand existing patterns, ' +
      'identify files to create/modify, and define the exact code structure to follow. ' +
      'READ-ONLY: this agent never writes files.',
    kernelApiVersion: KERNEL_API_VERSION,
    workflowRole: 'researcher',
    rolePrompt: RESEARCHER_SYSTEM_PROMPT,
    capabilities: ['search_codebase', 'read_code', 'read_adrs', 'ask_delegator'],
    ...(model === undefined ? {} : { model }),
    responseFormat: researchArtifactSchema as never,
    // The budget this delegate was granted lives in the turn ledger, not in the
    // recursion limit: deepagents starts every subagent with a fresh graph run.
    middleware: [createSubagentBudgetMiddleware()] as any[],
  };
}

/**
 * Creates a Researcher specification with an optional role-specific model.
 *
 * @param model - Model string or chat model selected by the orchestration policy.
 * @returns A read-only Researcher subagent specification.
 */
export function createResearcherSubAgent(
  model?: SubAgent['model'],
  context: AgentRuntimeContext = createDefaultAgentRuntimeContext(),
): SubAgent {
  return buildSubagentFromProfile(createResearcherRoleProfile(model), context);
}

/** Default Researcher specification retained for callers using the legacy import. */
export const researcherSubAgent: SubAgent = createResearcherSubAgent();
