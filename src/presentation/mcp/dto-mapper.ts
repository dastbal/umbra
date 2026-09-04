import { McpToolResult } from './mcp.contracts';

/**
 * The DTO boundary between Umbra's tools and a foreign client.
 *
 * ## Why this is not optional
 *
 * Umbra's tools return strings written for **Umbra's own prompt**.
 * `formatAuthorizationFailure` returns `❌ DENIED: …`; `integrityCheckTool`
 * returns `❌ APPROVAL_REQUIRED: …`; `askCodebaseTool` ends its report with
 * `💡 AGENT HINT: … run: read_file("…")`. The system prompt that gives that
 * vocabulary meaning — `WRITER_PROTOCOL` in `deep-agent-factory.ts` — is not
 * present in Claude Code, Codex or Gemini CLI.
 *
 * A foreign model reading `❌ DENIED` has no idea who denied what, or that it
 * cannot appeal. Reading `run: read_file(...)` it is told to call a tool this
 * server does not publish, which is the ADR-013 defect arriving from the
 * opposite direction: instructions for a tool that is not there.
 *
 * So the rule this project already follows everywhere else applies: **a
 * presentation layer returns DTOs, never internals.** Same law, new
 * presentation.
 *
 * ## The allowlist rule
 *
 * Recognised prefixes are translated. Everything else passes through as text
 * with the internal hints stripped — the same posture as `toSafeEvent` in
 * `ai-agent-http.module.ts`, where an unrecognised event is dropped rather
 * than forwarded and hoped for.
 */

/**
 * Internal markers that must never reach a client verbatim, with the
 * client-facing sentence that replaces each.
 *
 * Ordered longest-prefix-first so `❌ APPROVAL_REQUIRED` is not matched by a
 * shorter generic rule.
 */
const INTERNAL_PREFIXES: readonly { marker: string; replacement: string }[] = [
  {
    marker: '❌ APPROVAL_REQUIRED:',
    replacement:
      'Refused: this action needs an interactive operator approval, which an MCP server has no channel for. ' +
      'Umbra publishes read-only capabilities here by design.',
  },
  {
    marker: '❌ DENIED:',
    replacement:
      'Refused: the request falls outside the workspace this server was launched against.',
  },
];

/**
 * Internal instructions to the agent, which mean nothing to a foreign client
 * and actively mislead it by naming tools this server does not publish.
 */
const INTERNAL_HINT_PATTERNS: readonly RegExp[] = [
  /^\s*💡 \*\*AGENT HINT:\*\*.*$/gm,
  /^\s*💡 AGENT HINT:.*$/gm,
];

/**
 * Converts one tool's raw string output into an MCP result.
 *
 * @param raw - Exactly what the Umbra tool returned.
 * @returns A client-facing result, with `isError` set when the tool refused.
 */
export function toToolResult(raw: string): McpToolResult {
  for (const { marker, replacement } of INTERNAL_PREFIXES) {
    if (raw.startsWith(marker)) {
      return { content: [{ type: 'text', text: replacement }], isError: true };
    }
  }

  const text = stripInternalHints(raw);

  // A leading ❌ from any other failure path is reported as an error rather
  // than as successful content. A client that cannot tell a failure from an
  // answer will feed the failure to its model as fact.
  const isError = raw.startsWith('❌');

  return isError
    ? { content: [{ type: 'text', text }], isError: true }
    : { content: [{ type: 'text', text }] };
}

/**
 * Builds an error result for a failure that happened outside a tool body.
 *
 * @param message - What went wrong, safe to show.
 * @returns An error result.
 */
export function toErrorResult(message: string): McpToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Removes instructions addressed to Umbra's own agent.
 *
 * @param raw - Tool output.
 * @returns The text with internal hints removed.
 */
function stripInternalHints(raw: string): string {
  let text = raw;

  for (const pattern of INTERNAL_HINT_PATTERNS) {
    text = text.replace(pattern, '');
  }

  // Collapse the blank runs the removals leave behind, so the output does not
  // read as truncated.
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Prepends provenance to an answer that came from the semantic index.
 *
 * ADR-017's third failure was an index that reported success over missing
 * content. Here the reader of that claim is another agent with no terminal to
 * check, so the answer states which provider built the index, when, and whether
 * it is complete. The client is not asked to trust: it is told.
 *
 * The provider named here is the one that **built the index**, read from the
 * stamp on disk, not the one selected at launch. Naming the launch selection
 * over an answer computed from another provider's vectors is worse than
 * publishing no header at all: it is a confident, incorrect statement of
 * origin. When the two disagree, `queriedWith` says so instead of the header
 * quietly choosing one.
 *
 * @param text - The answer body.
 * @param provenance - What is known about the index that produced it.
 * @returns The answer with a provenance header.
 */
export function withProvenance(
  text: string,
  provenance: {
    provider: string;
    model: string;
    indexedAt?: number;
    filesIndexed?: number;
    status?: 'complete' | 'partial' | 'empty';
    chunksSearched?: number;
    /** Set only when the active provider differs from the one that indexed. */
    queriedWith?: string;
  },
): string {
  const parts = [`embeddings: ${provenance.provider}/${provenance.model}`];

  if (provenance.queriedWith !== undefined) {
    parts.push(`WARNING: queried with ${provenance.queriedWith} — provider mismatch`);
  }

  if (provenance.chunksSearched !== undefined) {
    parts.push(`${provenance.chunksSearched} chunks searched`);
  }
  if (provenance.filesIndexed !== undefined) {
    parts.push(`${provenance.filesIndexed} files indexed`);
  }
  if (provenance.indexedAt !== undefined) {
    parts.push(`indexed ${new Date(provenance.indexedAt).toISOString()}`);
  }
  if (provenance.status === 'partial') {
    parts.push('INDEX INCOMPLETE — some files failed to embed');
  }

  return `[${parts.join(' · ')}]\n\n${text}`;
}
