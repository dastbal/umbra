import { z } from 'zod';

/** A source-backed citation attached to a claim made by an analysis agent. */
export const evidenceCitationSchema = z.object({
  /** Relative path inside the project root. */
  path: z.string().trim().min(1),
  /** Optional 1-based source line when the agent can identify it reliably. */
  line: z.number().int().positive().optional(),
  /** The exact claim supported by this source. */
  claim: z.string().trim().min(1),
  /** How the source was obtained; inference is never accepted as evidence. */
  kind: z.enum(['direct', 'retrieved']),
}).strict();

/** A claim that cannot be returned without at least one concrete citation. */
export const groundedFindingSchema = z.object({
  claim: z.string().trim().min(1),
  confidence: z.enum(['high', 'medium', 'low']),
  evidence: z.array(evidenceCitationSchema).min(1),
}).strict();

/** Structured, read-only report used when the agent analyzes a codebase. */
export const groundedAnalysisSchema = z.object({
  summary: z.string().trim().min(1),
  findings: z.array(groundedFindingSchema),
  unknowns: z.array(z.string().trim().min(1)),
  filesReferenced: z.array(z.string().trim().min(1)),
}).strict();

/** Source-backed evidence citation type. */
export type EvidenceCitation = z.infer<typeof evidenceCitationSchema>;

/** Source-backed finding type. */
export type GroundedFinding = z.infer<typeof groundedFindingSchema>;

/** Structured grounded-analysis type. */
export type GroundedAnalysis = z.infer<typeof groundedAnalysisSchema>;

/** Evidence source available to the agent for a particular analysis flow. */
export type EvidenceProtocolMode = 'tool-research' | 'preloaded-manifest';

/**
 * Builds the mandatory investigation protocol for analysis-capable agents.
 *
 * This is deliberately explicit because a generic request such as "explain the
 * project" otherwise permits a model to answer from prior knowledge without
 * reading the current workspace.
 *
 * @param mode - Whether the agent investigates with tools or uses a bounded
 * preloaded manifest supplied by the host.
 * @returns Prompt instructions that require source-backed evidence before claims.
 */
export function buildEvidenceProtocolPrompt(
  mode: EvidenceProtocolMode = 'tool-research',
): string {
  const investigation = mode === 'preloaded-manifest'
    ? `
1. The machine-collected manifest supplied below is the source of truth for this one-shot report.
2. Answer directly from that manifest. Do not invoke tools or search for extra evidence.
3. If the manifest does not prove a requested fact, write "No verificado" in unknowns instead of guessing.`
    : `
1. Do not answer before investigating the current workspace.
2. Call list_files for the relevant directory and ask_codebase for the exact question.
3. Use safe_read_file on the most relevant files returned by the search. Read the active
   factory/entry point and at least one concrete implementation or test before concluding.`;

  return `
🔎 EVIDENCE-GATED ANALYSIS PROTOCOL:
This protocol applies to every explain, analyze, review, audit, architecture, overview,
performance, or "what does this project do" request.

${investigation}
4. Every factual claim must include a relative file path, and a 1-based line when known.
5. Separate direct evidence from inference. Inference must be labeled explicitly; never
   present a generic best practice as if it were present in this repository.
6. If evidence is missing, write "No verificado" in unknowns instead of guessing.
7. Do not modify files during analysis.
8. Keep the final answer compact: summary, findings with evidence, unknowns, and files referenced.
`;
}
