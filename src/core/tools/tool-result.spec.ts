import { z } from 'zod';
import { createToolResultSchema } from './tool-result';

describe('shared tool result contract', () => {
  const schema = createToolResultSchema(z.enum(['READY', 'FAILED']), z.object({ count: z.number() }));
  const base = { schemaVersion: 1, code: 'READY', summary: 'done', data: { count: 1 }, evidence: [], diagnostics: [], truncated: false, retryable: false };

  it.each(['success', 'partial', 'empty', 'abstained'] as const)('accepts %s outcomes', (status) => {
    expect(schema.parse({ ...base, status }).status).toBe(status);
  });

  it.each(['blocked', 'error'] as const)('requires diagnostics for %s outcomes', (status) => {
    expect(() => schema.parse({ ...base, status })).toThrow();
    expect(schema.parse({ ...base, status, code: 'FAILED', diagnostics: [{ severity: 'error', code: 'FAILED', message: 'failure' }] }).status).toBe(status);
  });
});
