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
export type ArtifactStatus = 'ready' | 'passed' | 'failed' | 'blocked' | 'partial';

/**
 * Compact, read-only handoff from the Researcher to the Coder.
 *
 * The artifact deliberately contains references and decisions instead of a
 * full transcript so the Supervisor context remains bounded.
 */
export interface ResearchArtifact {
  /**
   * Whether the research is ready for implementation.
   *
   * `partial` was added when delegation budgets were introduced: a delegate
   * that exhausts its allotment must be able to hand back what it verified.
   * Before it existed the only way to end an unfinished investigation was an
   * exception, which discarded every finding the delegate had already earned.
   * A partial handoff never authorizes implementation — see
   * `evaluateDelegation`.
   */
  status: 'ready' | 'blocked' | 'partial';
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
  /**
   * Questions the delegate could not resolve, left explicit rather than
   * guessed. Required in practice for a `partial` handoff.
   */
  unknowns?: string[];
  /** Questions the delegate would ask if the investigation continued. */
  openQuestions?: string[];
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

/**
 * Runtime validator for the compact handoff returned by the Researcher.
 *
 * Two rules are enforced beyond the field shapes, both consequences of the
 * `partial` state:
 *
 * - Evidence is mandatory for a `ready` handoff only. A delegate that ran out
 *   of budget before verifying anything must still be able to say so; forcing a
 *   citation there is an invitation to fabricate one.
 * - A `partial` handoff must list what stayed unknown. A partial result whose
 *   gaps are not stated is indistinguishable from a complete one, which is the
 *   single way this state becomes dangerous.
 */
export const researchArtifactSchema = z.object({
  status: z.enum(['ready', 'blocked', 'partial']),
  objective: z.string(),
  relevantFiles: z.array(z.string()),
  findings: z.array(z.string()),
  evidence: z.array(evidenceCitationSchema),
  decisions: z.array(z.string()),
  risks: z.array(z.string()),
  testPlan: z.array(z.string()),
  constraints: z.array(z.string()),
  unknowns: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([]),
  nextAction: z.string(),
}).superRefine((artifact, ctx) => {
  if (artifact.status === 'ready' && artifact.evidence.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['evidence'],
      message: 'A ready handoff must cite at least one verified source.',
    });
  }
  if (artifact.status === 'partial' && artifact.unknowns.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['unknowns'],
      message: 'A partial handoff must state what stayed unknown.',
    });
  }
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
