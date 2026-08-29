import { SubAgent } from 'deepagents';
import { verificationArtifactSchema } from '../agent/contracts';
import { createSubagentBudgetMiddleware } from '../agent/delegation/subagent-budget.middleware';
import {
  KERNEL_API_VERSION,
  buildSubagentFromProfile,
  createDefaultAgentRuntimeContext,
  type AgentRuntimeContext,
  type RoleProfile,
} from '../agent/agent-kernel';

/** System prompt for the read-only verification stage. */
export const VERIFIER_SYSTEM_PROMPT = `You are a Verification Engineer for a NestJS TypeScript project.

You are READ-ONLY. Never call a write tool and never edit, delete, format, or generate files.
Inspect the files named by the Supervisor, run the relevant Jest tests, and run the TypeScript
integrity check. Compare the evidence with the Researcher handoff and report only a compact JSON
artifact matching the response schema. Mark passed only when both testsPassed and
typeCheckPassed are true. Put every unresolved issue in remainingIssues and state one nextAction.
Do not include a transcript or large logs.

Your order is the whole brief: you cannot see the conversation that produced it. When it does
not settle what counts as verified, call ask_delegator rather than deciding for yourself.
Consult list_adrs when a decision record governs what the change was allowed to do. Your tool
attempts come from one budget shared by the whole turn; if you run out, report what you actually
ran and put the rest in remainingIssues.`;

/** Creates the Verifier profession, with a structurally read-only capability set. */
export function createVerifierRoleProfile(model?: SubAgent['model']): RoleProfile {
  return {
    id: 'verifier',
    displayName: 'Verifier',
    description:
      'Runs focused tests and TypeScript checks after implementation. It is strictly read-only, ' +
      'returns compact evidence, and never modifies project files.',
    kernelApiVersion: KERNEL_API_VERSION,
    workflowRole: 'verifier',
    rolePrompt: VERIFIER_SYSTEM_PROMPT,
    capabilities: ['read_code', 'run_tests', 'verify_integrity', 'read_adrs', 'ask_delegator'],
    ...(model === undefined ? {} : { model }),
    responseFormat: verificationArtifactSchema as never,
    middleware: [createSubagentBudgetMiddleware()] as any[],
  };
}

/**
 * Creates a Verifier specification with an optional role-specific model.
 *
 * @param model - Model string or chat model selected by the orchestration policy.
 * @returns A read-only Verifier subagent specification.
 */
export function createVerifierSubAgent(
  model?: SubAgent['model'],
  context: AgentRuntimeContext = createDefaultAgentRuntimeContext(),
): SubAgent {
  return buildSubagentFromProfile(createVerifierRoleProfile(model), context);
}

/** Default Verifier specification for callers that do not provide a model. */
export const verifierSubAgent: SubAgent = createVerifierSubAgent();
