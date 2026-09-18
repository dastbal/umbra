import { ToolResult } from '../../core/tools/tool-result';

/** Converts a LangChain tool event failure into Umbra's shared result contract. */
export function toolExecutionError(error: unknown): ToolResult<'TOOL_EXECUTION_ERROR', Record<string, never>> {
  return {
    schemaVersion: 1, status: 'error', code: 'TOOL_EXECUTION_ERROR',
    summary: 'Tool execution failed.', data: {}, evidence: [],
    diagnostics: [{ severity: 'error', code: 'TOOL_EXECUTION_ERROR', message: String(error ?? 'Unknown tool error') }],
    truncated: false, retryable: false,
  };
}
