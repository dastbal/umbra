import { z } from 'zod';

/** Stable states shared by every structured Umbra tool result. */
export const toolResultStatusSchema = z.enum([
  'success',
  'partial',
  'empty',
  'abstained',
  'blocked',
  'error',
]);

/** A source location that supports a tool result. */
export const toolEvidenceSchema = z.object({
  path: z.string(),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  reason: z.string().optional(),
});

/** A machine-readable diagnostic attached to a tool result. */
export const toolDiagnosticSchema = z.object({
  severity: z.enum(['info', 'warning', 'error']),
  code: z.string(),
  message: z.string(),
  path: z.string().optional(),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
});

/**
 * Which git worktree a result describes, when the caller selected one (ADR-038).
 *
 * Index-backed evidence paths keep the index's form, relative to the served
 * root: for the served repository's own worktrees that is also the path in the
 * worktree, and for a submodule's worktree `indexPrefix` says what to strip.
 * Live-search evidence is relative to the worktree itself.
 */
export const toolWorktreeSchema = z.object({
  /** Canonical absolute root of the worktree the answer is about. */
  path: z.string(),
  /** Checked-out branch, when not detached. */
  branch: z.string().optional(),
  /** Checked-out commit. */
  head: z.string().optional(),
  /** True when the selection is the served repository's own checkout. */
  isPinnedRoot: z.boolean(),
  /**
   * Present when the worktree belongs to a submodule: evidence paths are the
   * index's, so `<indexPrefix>/src/a.ts` in an answer is `src/a.ts` in this worktree.
   */
  indexPrefix: z.string().optional(),
  /** Indexed files whose worktree content replaced the base index's for this answer. */
  changedFiles: z.number().int().nonnegative(),
  /** Indexed files the worktree does not have, hidden for this answer. */
  deletedFiles: z.number().int().nonnegative(),
  /** Chunks the provider embedded for this worktree's overlay; zero on a cache hit. */
  chunksEmbedded: z.number().int().nonnegative(),
  /** Chunks whose vector was reused from the base index or an earlier overlay. */
  chunksReused: z.number().int().nonnegative(),
  /** Wall time to prepare and run the worktree read. */
  elapsedMs: z.number().nonnegative(),
});

/** Source evidence suitable for CLI, MCP and telemetry projections. */
export type ToolEvidence = z.infer<typeof toolEvidenceSchema>;

/** Worktree provenance suitable for CLI, MCP and telemetry projections. */
export type ToolWorktree = z.infer<typeof toolWorktreeSchema>;

/** Diagnostic suitable for CLI, MCP and telemetry projections. */
export type ToolDiagnostic = z.infer<typeof toolDiagnosticSchema>;

interface ToolResultCommon<TCode extends string, TData> {
  readonly schemaVersion: 1;
  readonly code: TCode;
  readonly summary: string;
  readonly data: TData;
  readonly evidence: readonly ToolEvidence[];
  readonly diagnostics: readonly ToolDiagnostic[];
  readonly truncated: boolean;
  readonly retryable: boolean;
  readonly nextAction?: string;
  /** Present only when the caller selected a worktree. */
  readonly worktree?: ToolWorktree;
}

/** Valid structured outcome returned by a read-only Umbra capability. */
export type ToolResult<TCode extends string, TData> =
  | (ToolResultCommon<TCode, TData> & {
      readonly status: 'success' | 'partial' | 'empty' | 'abstained';
    })
  | (ToolResultCommon<TCode, TData> & {
      readonly status: 'blocked' | 'error';
      readonly diagnostics: readonly [ToolDiagnostic, ...ToolDiagnostic[]];
    });

/** Creates the public Zod output contract for one tool-specific data shape. */
export function createToolResultSchema<TData extends z.ZodType, TCode extends z.ZodType<string>>(
  code: TCode,
  data: TData,
): z.ZodType<ToolResult<z.infer<TCode>, z.infer<TData>>> {
  const common = {
    schemaVersion: z.literal(1),
    code,
    summary: z.string(),
    data,
    evidence: z.array(toolEvidenceSchema),
    diagnostics: z.array(toolDiagnosticSchema),
    truncated: z.boolean(),
    retryable: z.boolean(),
    nextAction: z.string().optional(),
    worktree: toolWorktreeSchema.optional(),
  };
  // MCP SDK 1.x normalizes an advertised output schema as an object before it
  // validates `structuredContent`. A discriminated union is valid Zod, but it
  // has no object root for that SDK boundary. Keep the same state invariant in
  // the canonical Zod contract while exposing one object-shaped schema to every
  // presentation adapter.
  return z.object({ ...common, status: toolResultStatusSchema })
    .superRefine((result, context) => {
      if ((result.status === 'blocked' || result.status === 'error') && result.diagnostics.length === 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['diagnostics'],
          message: 'Blocked and error results require at least one diagnostic.',
        });
      }
    }) as unknown as z.ZodType<ToolResult<z.infer<TCode>, z.infer<TData>>>;
}

/** Narrows an unknown LangChain artifact to Umbra's shared result contract. */
export function isToolResult(value: unknown): value is ToolResult<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === 1
    && toolResultStatusSchema.safeParse(record.status).success
    && typeof record.code === 'string'
    && typeof record.summary === 'string'
    && Array.isArray(record.evidence)
    && Array.isArray(record.diagnostics)
    && typeof record.truncated === 'boolean'
    && typeof record.retryable === 'boolean';
}

/** Returns true when MCP should mark the tool call as failed. */
export function isToolResultError(result: ToolResult<string, unknown>): boolean {
  return result.status === 'blocked' || result.status === 'error';
}
