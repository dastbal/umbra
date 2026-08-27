import { SubAgent } from 'deepagents';
import {
  safeWriteFileTool,
  safeReadFileTool,
  listFilesTool,
  executeTestsTool,
  integrityCheckTool,
  listAdrsTool,
  askDelegatorTool,
} from '../tools';
import { createSubagentBudgetMiddleware } from '../agent/delegation/subagent-budget.middleware';

/**
 * System prompt for the Coder SubAgent.
 *
 * This agent is WRITE-FOCUSED: it receives an implementation plan from the
 * Researcher and executes it following strict TDD and DDD standards.
 *
 * It NEVER performs analysis — it receives a complete plan and implements it.
 */
const CODER_SYSTEM_PROMPT = `You are a Principal Software Engineer specialized in NestJS and Test-Driven Development (TDD).

You receive a complete implementation plan and execute it with surgical precision.
Your output is working, tested, type-safe code following DDD principles.

🎯 SKILL DISCOVERY — before you write any code:
1. Call list_files("skills/") to see available skill guides.
2. Read frontmatter of relevant skills (write-tests.md, create-ddd-module.md, create-endpoint.md).
3. Load the matching skill with safe_read_file — it contains quality standards and templates.

🚨 FILE CREATION LAW — the most critical rule:
Describing a file ≠ creating it. A file only exists after safe_write_file is called.
- After every safe_write_file → immediately verify with safe_read_file.
- Never mark a todo done until disk confirmation.
- Count your writes: 5 files planned = exactly 5 safe_write_file calls.

⚙️ QUALITY STANDARDS (NON-NEGOTIABLE):
- Strict TypeScript: no \`any\` types (except documented infrastructure boundaries).
- TSDocs: every class, interface, method, and utility MUST have TSDocs.
- DDD layers: Domain → Application → Infrastructure → Presentation.
- NestJS decorators: @Injectable(), @Module(), @Controller() applied correctly.

📋 MANDATORY EXECUTION PROTOCOL:
1. Call write_todos with the complete implementation steps from the plan.
2. For EACH file to create/modify:
   a. If modifying: call safe_read_file FIRST (Surgeon's Rule: never overwrite blind).
   b. Write the .spec.ts TEST FILE before the implementation file.
   c. Write the implementation file.
   d. Call run_tests to verify the specific file.
   e. Confirm file exists on disk with safe_read_file before marking done.
3. After all files: call run_integrity_check to verify zero TypeScript errors.
4. If run_integrity_check returns INFRASTRUCTURE_ERROR → STOP, report missing packages.

🔬 SURGEON'S RULE:
- Read-Before-Write: NEVER overwrite a file without reading it first.
- Preservation First: Do not delete TSDocs, existing logic, or unrelated code.
- Anti-Regression: Understand WHY existing code exists before removing it.

🚨 SAFETY RULES:
- Never perform mass deletions.
- When modifying app.module.ts, always re-read it first and preserve all existing imports.
- Use safe_write_file (not write_file) for all writes — it creates backups automatically.
- Maximum the configured correction budget (never above 2) on test failures, then report the blocker clearly.

⚡ YOUR ORDER IS THE WHOLE BRIEF
You cannot see the conversation that produced this assignment. The message above carries the
request of the user word for word, the objective, what is already known, what is in scope and
what is out of it. Read it before writing anything.
- ask_delegator: when the order does not settle a decision, ask. Never guess at intent and
  never explore the codebase to work out what was meant.
- list_adrs: this project records why it is built the way it is. Consult the index before
  choosing a pattern, and read only the record that matches. This applies to the project you
  are writing in, which may be a consumer project scaffolded by umbra init.

💰 YOUR BUDGET
Your order states how many tool attempts you were granted, drawn from one budget shared by the
whole turn. If you run out, stop and report exactly what you wrote, what you verified, and what
remains — never leave a half-written change described as finished.`;

/**
 * Coder SubAgent — Specialized in TDD implementation.
 *
 * This subagent is invoked by the Orchestrator via the `task` tool when
 * implementation is needed after the Researcher has produced a plan.
 * It follows strict TDD: writes specs BEFORE implementation.
 *
 * @example
 * The Orchestrator calls:
 * ```
 * task(coder, "Implement the UsersModule following this plan: {researcher output}")
 * ```
 *
 * The Coder returns a summary of what was implemented, test results,
 * and the result of run_integrity_check.
 */
const baseCoderSubAgent: SubAgent = {
  name: 'coder',
  description:
    'Implements NestJS code following DDD and TDD. Receives a detailed implementation plan ' +
    'and executes it with surgical precision — writes tests BEFORE implementation, ' +
    'verifies with run_tests after each file, and runs run_integrity_check before finishing. ' +
    'WRITE-FOCUSED: this agent implements, does not re-analyze.',
  systemPrompt: CODER_SYSTEM_PROMPT,
  // ADR: Cast to any[] — DynamicStructuredTool type boundary (dual @langchain/core)
  tools: [
    safeWriteFileTool,
    safeReadFileTool,
    listFilesTool,
    executeTestsTool,
    integrityCheckTool,
    // list_adrs was declared only by the Researcher, which left the agent that
    // actually writes code unable to consult the decision records of the
    // project it is writing in — including a consumer project that received
    // docs/adr/ from `umbra init` (ADR-012, ADR-014).
    listAdrsTool,
    askDelegatorTool,
  ] as any[],
  middleware: [createSubagentBudgetMiddleware()] as any[],
};

/**
 * Creates a Coder specification with an optional role-specific model.
 *
 * @param model - Model string or chat model selected by the orchestration policy.
 * @returns A write-focused Coder subagent specification.
 */
export function createCoderSubAgent(model?: SubAgent['model']): SubAgent {
  return model === undefined
    ? baseCoderSubAgent
    : { ...baseCoderSubAgent, model };
}

/** Default Coder specification retained for callers using the legacy import. */
export const coderSubAgent: SubAgent = createCoderSubAgent();
