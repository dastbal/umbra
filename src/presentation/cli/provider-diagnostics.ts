import { mkdirSync, writeFileSync } from 'fs';
import * as path from 'path';

/** Upper bound on the captured request body, in characters. */
const MAX_BODY_CHARS = 200_000;

/**
 * A redacted snapshot of the request a provider rejected.
 *
 * Deliberately carries no headers. See {@link extractProviderDiagnostic}.
 */
export interface ProviderDiagnostic {
  status?: number;
  url?: string;
  method?: string;
  message: string;
  requestBody?: string;
  requestBodyTruncated?: boolean;
}

/**
 * Extracts what a rejected provider request can tell us, minus the credential.
 *
 * `@langchain/google-common` attaches the request context to the thrown error as
 * `error.details = { url, opts, fetchOptions }`, and builds its message from the
 * response body — but only when that body is non-empty, which is why a rejected
 * Gemini tool cycle surfaced as a bare `status code 400` with nothing to act on.
 *
 * ⚠️ **`fetchOptions.headers` holds the credential.** `ApiKeyGoogleAuth.request()`
 * injects `X-Goog-Api-Key` there and the service-account client injects
 * `Authorization: Bearer …`, so the whole `details` object is credential-bearing.
 * This function copies named fields out; it never copies the headers, and it
 * never spreads `details`. Adding a spread here would write a Google credential
 * to disk.
 *
 * @param error - The value thrown by the provider client.
 * @returns The redacted snapshot, or `undefined` when there is nothing to record.
 */
export function extractProviderDiagnostic(error: unknown): ProviderDiagnostic | undefined {
  if (typeof error !== 'object' || error === null) return undefined;

  const candidate = error as {
    message?: unknown;
    details?: { url?: unknown; opts?: { method?: unknown }; fetchOptions?: { method?: unknown; body?: unknown } };
    response?: { status?: unknown };
  };

  const message = typeof candidate.message === 'string' ? candidate.message : String(error);
  const details = candidate.details;
  const rawBody = details?.fetchOptions?.body;
  const body = typeof rawBody === 'string' ? rawBody : undefined;
  const truncated = body !== undefined && body.length > MAX_BODY_CHARS;

  const diagnostic: ProviderDiagnostic = { message };
  if (typeof candidate.response?.status === 'number') diagnostic.status = candidate.response.status;
  if (typeof details?.url === 'string') diagnostic.url = details.url;

  const method = details?.opts?.method ?? details?.fetchOptions?.method;
  if (typeof method === 'string') diagnostic.method = method;

  if (body !== undefined) {
    diagnostic.requestBody = truncated ? body.slice(0, MAX_BODY_CHARS) : body;
    if (truncated) diagnostic.requestBodyTruncated = true;
  }

  // A message alone adds nothing the audit line does not already carry.
  return diagnostic.requestBody === undefined && diagnostic.url === undefined
    ? undefined
    : diagnostic;
}

/**
 * Writes a provider diagnostic beside the telemetry, in its own file.
 *
 * It is kept out of `interactive-turns.jsonl` on purpose: that file hashes the
 * thread id, excludes payloads, and is read by `umbra metrics`, so it is safe to
 * hand to someone else. A request body carries the system prompt and the content
 * of every file the agent read, which is not. Only the path crosses into the
 * audit record.
 *
 * @param rootDir - Workspace root; the file lands under `.agent/diagnostics/`.
 * @param auditId - Identifier that ties this file to its audit line.
 * @param diagnostic - The redacted snapshot to persist.
 * @returns The workspace-relative path written, or `undefined` on failure.
 */
export function writeProviderDiagnostic(
  rootDir: string,
  auditId: string,
  diagnostic: ProviderDiagnostic,
): string | undefined {
  try {
    const directory = path.join(rootDir, '.agent', 'diagnostics');
    mkdirSync(directory, { recursive: true });
    const fileName = `${auditId}.json`;
    writeFileSync(path.join(directory, fileName), `${JSON.stringify(diagnostic, null, 2)}\n`, 'utf8');
    return path.join('.agent', 'diagnostics', fileName);
  } catch {
    // Diagnostics are best effort; they must never affect agent execution.
    return undefined;
  }
}
