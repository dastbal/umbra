import { diagnoseOffline } from './offline-diagnosis';

describe('diagnoseOffline', () => {
  it('recognises the DNS failure that reached the operator as a stack trace', () => {
    // The live failure of 2026-08-28, verbatim from the session log.
    const error = new Error(
      'request to https://aiplatform.googleapis.com/v1/projects/blue-label/locations/global/'
      + 'publishers/google/models/gemini-2.5-flash-lite:generateContent failed, '
      + 'reason: getaddrinfo ENOTFOUND aiplatform.googleapis.com',
    );

    expect(diagnoseOffline(error)?.message).toContain('Sin conexión');
  });

  it('says the request never left, which is the operator real question', () => {
    // The reasonable fear is that money was spent or something was half-applied.
    const diagnosis = diagnoseOffline(new Error('getaddrinfo EAI_AGAIN aiplatform.googleapis.com'));

    expect(diagnosis?.message).toContain('no llegó a salir');
    expect(diagnosis?.hint).toContain('no se gastó nada');
  });

  it('finds the signature wrapped inside a provider error', () => {
    // The line that identifies this failure sat two levels down in the object
    // the provider threw.
    const wrapped = new Error('Model request failed');
    (wrapped as { cause?: unknown }).cause = new Error('fetch failed: ECONNREFUSED');

    expect(diagnoseOffline(wrapped)).toBeDefined();
  });

  it('reads a bare error code with no message', () => {
    expect(diagnoseOffline({ code: 'ENETUNREACH' })).toBeDefined();
  });

  it.each(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETDOWN', 'EHOSTUNREACH', 'ETIMEDOUT'])(
    'recognises %s',
    (code) => {
      expect(diagnoseOffline(new Error(`connect ${code} 1.2.3.4:443`))).toBeDefined();
    },
  );

  it('leaves a provider rejection alone, because that one was paid for', () => {
    // A rejected request has been billed and may need a different prompt. An
    // unreachable one cost nothing and needs only the network back.
    expect(diagnoseOffline(new Error('400 Bad Request: invalid tool schema'))).toBeUndefined();
    expect(diagnoseOffline(new Error('Recursion limit of 50 reached'))).toBeUndefined();
    expect(diagnoseOffline(new Error('429 Too Many Requests'))).toBeUndefined();
  });

  it('survives whatever the stream throws', () => {
    expect(diagnoseOffline(undefined)).toBeUndefined();
    expect(diagnoseOffline(null)).toBeUndefined();
    expect(diagnoseOffline('plain string')).toBeUndefined();
    expect(diagnoseOffline({})).toBeUndefined();
  });
});
