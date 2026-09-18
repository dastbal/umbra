import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { WorkspaceEvidenceService } from './workspace-evidence';

describe('WorkspaceEvidenceService', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-workspace-evidence-'));
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  function write(relativePath: string, content: string): void {
    const absolutePath = path.join(rootDir, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content, 'utf8');
  }

  it('maps safe artifact types without treating them as indexed source', () => {
    write('src/payments.ts', 'export const payment = true;');
    write('prisma/schema.prisma', 'model Payment { id String @id }');
    write('db/migrations/001.sql', 'CREATE TABLE payments (id TEXT);');
    write('openapi/payments.yaml', 'openapi: 3.0.0');
    write('config/payment.json', '{"provider":"epay"}');
    write('.env', 'PAYMENT_SECRET=do-not-expose');
    write('node_modules/package/index.js', 'PAYMENT_SECRET=dependency-secret');
    write('package-lock.json', '{"lockfileVersion":3}');

    const inventory = new WorkspaceEvidenceService(rootDir).inspect();

    expect(inventory.filesByType).toEqual({
      json: 1,
      prisma: 1,
      sql: 1,
      typescript: 1,
      yaml: 1,
    });
    expect(inventory.excludedByReason).toEqual({
      'ignored-directory': 1,
      'secret-like-path': 1,
      'unhelpful-artifact': 1,
    });
  });

  it('finds literal evidence in safe files that are outside the semantic index', () => {
    write('prisma/schema.prisma', 'model Payment {\n  idempotencyKey String? @unique\n}');
    write('db/migrations/001.sql', 'CREATE UNIQUE INDEX payment_idempotency ON payment(idempotency_key);');
    write('openapi/payments.yaml', 'description: idempotencyKey is accepted');
    write('src/handler.ts', 'const key = "idempotencyKey";');

    const result = new WorkspaceEvidenceService(rootDir).search({ query: 'idempotencyKey' });

    expect(result.matches.map((match) => [match.path, match.line])).toEqual([
      ['openapi/payments.yaml', 1],
      ['prisma/schema.prisma', 2],
      ['src/handler.ts', 1],
    ]);
    expect(result.truncated).toBe(false);
  });

  it('never reads secret-like paths and reports bounded partial results', () => {
    write('.env.production', 'idempotencyKey=secret');
    write('config/public.json', '{"idempotencyKey":"public"}');
    write('src/one.ts', 'const idempotencyKey = 1;');
    write('src/two.ts', 'const idempotencyKey = 2;');

    const result = new WorkspaceEvidenceService(rootDir).search({ query: 'idempotencyKey', maxMatches: 2 });

    expect(result.matches).toHaveLength(2);
    expect(result.matches.map((match) => match.path)).not.toContain('.env.production');
    expect(result.truncated).toBe(true);
    expect(result.excludedByReason['secret-like-path']).toBe(1);
  });

  it('rejects a search path that escapes the pinned workspace', () => {
    write('src/handler.ts', 'const idempotencyKey = 1;');

    expect(() => new WorkspaceEvidenceService(rootDir).search({ query: 'idempotencyKey', path: '../' }))
      .toThrow('escapes the repository');
  });

  it('supports a direct safe-file search while refusing an ignored directory', () => {
    write('prisma/schema.prisma', 'model Payment {\n  idempotencyKey String? @unique\n}');
    write('node_modules/package/index.js', 'const idempotencyKey = "dependency";');

    const service = new WorkspaceEvidenceService(rootDir);

    expect(service.search({ query: 'idempotencyKey', path: 'prisma/schema.prisma' }).matches)
      .toMatchObject([{ path: 'prisma/schema.prisma', line: 2 }]);
    expect(() => service.search({ query: 'idempotencyKey', path: 'node_modules' }))
      .toThrow('excluded by policy');
  });
});
