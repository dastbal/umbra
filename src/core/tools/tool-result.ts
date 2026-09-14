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

/** Source evidence suitable for CLI, MCP and telemetry projections. */
export type ToolEvidence = z.infer<typeof toolEvidenceSchema>;

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
  };
  return z.discriminatedUnion('status', [
    z.object({ ...common, status: z.enum(['success', 'partial', 'empty', 'abstained']) }),
    z.object({ ...common, status: z.enum(['blocked', 'error']), diagnostics: z.array(toolDiagnosticSchema).min(1) }),
  ]) as unknown as z.ZodType<ToolResult<z.infer<TCode>, z.infer<TData>>>;
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
