import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { extractProviderDiagnostic, writeProviderDiagnostic } from './provider-diagnostics';

/**
 * Builds an error shaped exactly like the one `@langchain/google-common` throws:
 * `_throwRequestError` attaches `details = { url, opts, fetchOptions }`, and the
 * credential travels inside `fetchOptions.headers`.
 */
function googleRequestError(): Error & Record<string, unknown> {
  const error = new Error('Google request failed with status code 400') as Error & Record<string, unknown>;
  error.response = { status: 400 };
  error.details = {
    url: 'https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/l/publishers/google/models/gemini-3.5-flash:generateContent',
    opts: { method: 'POST' },
    fetchOptions: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': 'AIzaSyTOTALLY-SECRET-KEY',
        Authorization: 'Bearer ya29.SUPER-SECRET-TOKEN',
      },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hola' }] }] }),
    },
  };
  return error;
}

describe('provider diagnostics', () => {
  describe('extractProviderDiagnostic', () => {
    it('captures the request context that the error message lost', () => {
      const diagnostic = extractProviderDiagnostic(googleRequestError());

      expect(diagnostic).toBeDefined();
      expect(diagnostic!.status).toBe(400);
      expect(diagnostic!.method).toBe('POST');
      expect(diagnostic!.url).toContain('gemini-3.5-flash');
      expect(diagnostic!.requestBody).toContain('hola');
    });

    it('never carries the credential, in any field', () => {
      // The regression this guards: `error.details` is credential-bearing, so a
      // spread or a raw JSON.stringify of it writes a Google key to disk.
      const serialized = JSON.stringify(extractProviderDiagnostic(googleRequestError()));

      expect(serialized).not.toContain('AIzaSyTOTALLY-SECRET-KEY');
      expect(serialized).not.toContain('ya29.SUPER-SECRET-TOKEN');
      expect(serialized).not.toContain('Authorization');
      expect(serialized).not.toContain('X-Goog-Api-Key');
      expect(serialized).not.toContain('headers');
    });

    it('truncates an oversized body and says so', () => {
      const error = googleRequestError();
      (error.details as any).fetchOptions.body = 'x'.repeat(400_000);

      const diagnostic = extractProviderDiagnostic(error)!;
      expect(diagnostic.requestBodyTruncated).toBe(true);
      expect(diagnostic.requestBody!.length).toBeLessThan(400_000);
    });

    it('returns nothing for an error with no provider context', () => {
      expect(extractProviderDiagnostic(new Error('plain failure'))).toBeUndefined();
      expect(extractProviderDiagnostic('not an object')).toBeUndefined();
      expect(extractProviderDiagnostic(null)).toBeUndefined();
    });
  });

  describe('writeProviderDiagnostic', () => {
    let rootDir: string;

    beforeEach(() => { rootDir = mkdtempSync(join(tmpdir(), 'diag-')); });
    afterEach(() => { rmSync(rootDir, { recursive: true, force: true }); });

    it('writes the snapshot under .agent/diagnostics and returns its path', () => {
      const diagnostic = extractProviderDiagnostic(googleRequestError())!;
      const relative = writeProviderDiagnostic(rootDir, 'audit-1', diagnostic);

      expect(relative).toBe(join('.agent', 'diagnostics', 'audit-1.json'));
      const written = readFileSync(join(rootDir, relative!), 'utf8');
      expect(written).toContain('hola');
      expect(written).not.toContain('AIzaSyTOTALLY-SECRET-KEY');
    });

    it('keeps the payload out of the shareable telemetry file', () => {
      const diagnostic = extractProviderDiagnostic(googleRequestError())!;
      writeProviderDiagnostic(rootDir, 'audit-2', diagnostic);
      expect(existsSync(join(rootDir, '.agent', 'telemetry', 'interactive-turns.jsonl'))).toBe(false);
    });

    it('returns undefined instead of throwing when the write fails', () => {
      const diagnostic = extractProviderDiagnostic(googleRequestError())!;
      // A file where the directory must go makes mkdirSync fail.
      const blocked = join(rootDir, 'blocked');
      require('fs').writeFileSync(blocked, 'not a directory', 'utf8');
      expect(writeProviderDiagnostic(join(blocked, 'inner'), 'audit-3', diagnostic)).toBeUndefined();
    });
  });
});
