/**
 * Node and provider signatures that mean the network never carried the request.
 *
 * Each is a failure to *reach* the provider, not a failure the provider
 * returned. That distinction is the whole point: a rejected request has been
 * paid for and may need a different prompt, while an unreachable one has cost
 * nothing and needs only the network back.
 */
const OFFLINE_SIGNATURES: readonly RegExp[] = [
  /ENOTFOUND/,
  /EAI_AGAIN/,
  /ECONNREFUSED/,
  /ENETUNREACH/,
  /ENETDOWN/,
  /EHOSTUNREACH/,
  /ETIMEDOUT/,
  /getaddrinfo/i,
  /fetch failed/i,
  /socket hang up/i,
];

/** What the operator is told, and what the session should do about it. */
export interface OfflineDiagnosis {
  /** One sentence naming the cause in the operator's terms. */
  message: string;
  /** What they can do next. */
  hint: string;
}

/**
 * Recognises a turn that failed because the provider could not be reached.
 *
 * ## Why this is not just a nicer error string
 *
 * On 2026-08-28 a session lost DNS mid-conversation. What reached the operator
 * was a `GaxiosError` with a stack trace, a redacted request body, a URL object
 * printed field by field, and the line `getaddrinfo ENOTFOUND
 * aiplatform.googleapis.com` buried inside it. Nothing said "you are offline",
 * and nothing said what had happened to the message that had just been typed.
 *
 * The message was, in fact, fine: the request never left, so nothing was spent
 * and nothing was half-applied. That is worth saying out loud, because the
 * operator's reasonable fear is the opposite.
 *
 * **Deliberately no automatic retry.** A paid call retried on the operator's
 * behalf spends their money on a guess about when the network returns. The
 * session says what happened and waits to be told.
 *
 * @param error - The error that ended the turn.
 * @returns The diagnosis, or `undefined` when the failure was not the network.
 */
export function diagnoseOffline(error: unknown): OfflineDiagnosis | undefined {
  const text = describe(error);
  if (!OFFLINE_SIGNATURES.some((signature) => signature.test(text))) return undefined;

  return {
    message: 'Sin conexión con el proveedor del modelo. La petición no llegó a salir.',
    hint: 'Tu mensaje no se perdió y no se gastó nada. Reintentá cuando vuelva la red.',
  };
}

/**
 * Flattens an error into the text the signatures are matched against.
 *
 * Nested causes are followed because the transport error is usually wrapped:
 * the `getaddrinfo` line that identifies this failure sat two levels down
 * inside a provider error object.
 */
function describe(error: unknown, depth = 0): string {
  if (depth > 4 || error === null || error === undefined) return '';
  if (typeof error === 'string') return error;

  if (error instanceof Error) {
    const nested = (error as { cause?: unknown }).cause;
    const code = (error as { code?: unknown }).code;
    return [
      error.name,
      error.message,
      typeof code === 'string' ? code : '',
      describe(nested, depth + 1),
    ].join(' ');
  }

  if (typeof error === 'object') {
    const record = error as Record<string, unknown>;
    return [
      typeof record['code'] === 'string' ? record['code'] : '',
      typeof record['message'] === 'string' ? record['message'] : '',
      describe(record['cause'], depth + 1),
    ].join(' ');
  }

  return '';
}
