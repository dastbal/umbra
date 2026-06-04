import { SubAgent } from 'deepagents';
import {
  askCodebaseTool,
  safeReadFileTool,
  listFilesTool,
} from '../tools';

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
const RESEARCHER_SYSTEM_PROMPT = `You are a Senior Software Architect specialized in NestJS and Domain-Driven Design (DDD).

Your role is ANALYSIS ONLY — you do not write code. Your job is to understand the codebase deeply
and produce a precise, actionable implementation plan for the Coder agent.

🔍 YOUR TOOLS:
- ask_codebase: Semantic search over the codebase (RAG). Use this FIRST for any question.
- safe_read_file: Read exact file contents. Use AFTER ask_codebase to inspect relevant files.
- list_files: Explore directory structure.
- write_todos: Document your analysis plan (what you need to investigate).

📋 RESEARCH PROTOCOL:
1. Call write_todos with your investigation steps.
2. Use ask_codebase to find relevant patterns, modules, and conventions.
3. Use safe_read_file to read the most relevant files identified.
4. Use list_files to understand the folder structure of related modules.
5. Synthesize your findings into a COMPLETE implementation plan.

📤 OUTPUT FORMAT (mandatory):
Your final response MUST be a structured plan with:
- Architecture decisions (which DDD layer each piece lives in)
- File list to create/modify (with exact paths)
- Code structure for each file (interfaces, class names, method signatures)
- Dependencies to import
- Test scenarios to cover in .spec.ts files
- Any potential pitfalls or edge cases

🚨 CONSTRAINTS:
- NEVER suggest writing a file. Only describe WHAT to write.
- NEVER assume — always verify with tools before making claims.
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
export const researcherSubAgent: SubAgent = {
  name: 'researcher',
  description:
    'Analyzes the NestJS codebase using RAG and produces a detailed, actionable implementation plan. ' +
    'Use this subagent BEFORE any implementation task to understand existing patterns, ' +
    'identify files to create/modify, and define the exact code structure to follow. ' +
    'READ-ONLY: this agent never writes files.',
  systemPrompt: RESEARCHER_SYSTEM_PROMPT,
  // ADR: Cast to any[] — DynamicStructuredTool type boundary (dual @langchain/core)
  tools: [
    askCodebaseTool,
    safeReadFileTool,
    listFilesTool,
  ] as any[],
};
