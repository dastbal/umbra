import { z } from 'zod';
import { evidenceCitationSchema, type EvidenceCitation } from './evidence-protocol';

/** Roles available in the first-level orchestration graph. */
export type AgentRole =
  | 'supervisor'
  | 'researcher'
  | 'coder'
  | 'verifier'
  | 'summarizer';

/** Complexity classification used to decide whether delegation is necessary. */
export type TaskComplexity = 'small' | 'medium' | 'large';

/** Lifecycle states shared by task and handoff artifacts. */
export type ArtifactStatus = 'ready' | 'passed' | 'failed' | 'blocked';

/**
 * Compact, read-only handoff from the Researcher to the Coder.
 *
 * The artifact deliberately contains references and decisions instead of a
 * full transcript so the Supervisor context remains bounded.
 */
export interface ResearchArtifact {
  /** Whether the research is ready for implementation. */
  status: 'ready' | 'blocked';
  /** The implementation objective. */
  objective: string;
  /** Files that must be inspected or changed. */
  relevantFiles: string[];
  /** Verified observations from the codebase. */
  findings: string[];
  /** Source citations supporting the observations. */
  evidence: EvidenceCitation[];
  /** Architectural decisions required for implementation. */
  decisions: string[];
  /** Risks and unresolved concerns. */
  risks: string[];
  /** Tests the Coder must create or execute. */
  testPlan: string[];
  /** Constraints that must not be violated. */
  constraints: string[];
  /** The next action expected from the receiving agent. */
  nextAction: string;
}

/**
 * Compact verification result from the Verifier.
 */
export interface VerificationArtifact {
  /** Final verification state. */
  status: 'passed' | 'failed' | 'blocked';
  /** Whether the TypeScript integrity check passed. */
  typeCheckPassed: boolean;
  /** Whether the relevant test suite passed. */
  testsPassed: boolean;
  /** Files changed when verification started. */
  changedFiles: string[];
  /** Issues that remain after the allowed correction cycles. */
  remainingIssues: string[];
  /** The next action expected from the Supervisor. */
  nextAction: string;
}

/**
 * Final task result returned to the user and persisted as task metadata.
 */
export interface AgentTaskResult {
  /** Final task state. */
  status: 'completed' | 'failed' | 'blocked';
  /** Human-readable summary of the result. */
  summary: string;
  /** Architectural or implementation decisions made. */
  decisions: string[];
  /** Files changed by the Coder. */
  changedFiles: string[];
  /** Verification evidence, when a verification stage ran. */
  verification: VerificationArtifact;
  /** Known risks or follow-up work. */
  risks: string[];
  /** Estimated cost in USD, when pricing data is available. */
  costUsd?: number;
}

/** Runtime validator for the compact handoff returned by the Researcher. */
export const researchArtifactSchema = z.object({
  status: z.enum(['ready', 'blocked']),
  objective: z.string(),
  relevantFiles: z.array(z.string()),
  findings: z.array(z.string()),
  evidence: z.array(evidenceCitationSchema).min(1),
  decisions: z.array(z.string()),
  risks: z.array(z.string()),
  testPlan: z.array(z.string()),
  constraints: z.array(z.string()),
  nextAction: z.string(),
});

/** Runtime validator for the compact handoff returned by the Verifier. */
export const verificationArtifactSchema = z.object({
  status: z.enum(['passed', 'failed', 'blocked']),
  typeCheckPassed: z.boolean(),
  testsPassed: z.boolean(),
  changedFiles: z.array(z.string()),
  remainingIssues: z.array(z.string()),
  nextAction: z.string(),
});
