import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { executeWorkspaceSearch, formatWorkspaceSearchForModel } from './read-only-executions';

describe('executeWorkspaceSearch', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-workspace-search-'));
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('reports an explicitly requested secret-like file as blocked instead of empty', () => {
    fs.writeFileSync(path.join(rootDir, '.env'), 'ENCRYPTION_SECRET_KEY=secret', 'utf8');

    const result = executeWorkspaceSearch({ query: 'ENCRYPTION_SECRET_KEY', path: '.env' }, rootDir);

    expect(result).toMatchObject({
      status: 'blocked',
      code: 'WORKSPACE_SEARCH_ERROR',
      data: { query: 'ENCRYPTION_SECRET_KEY', path: '.env', scannedFiles: 0, matches: [] },
    });
    expect(result.diagnostics[0].message).toContain('excluded by policy');
  });

  it('keeps each live match framed with its own source path', () => {
    fs.mkdirSync(path.join(rootDir, 'prisma'), { recursive: true });
    fs.writeFileSync(path.join(rootDir, 'prisma', 'schema.prisma'), 'idempotencyKey', 'utf8');

    const result = executeWorkspaceSearch({ query: 'idempotencyKey', path: 'prisma/schema.prisma' }, rootDir);

    expect(formatWorkspaceSearchForModel(result)).toContain('BEGIN UNTRUSTED FILE CONTENT: prisma/schema.prisma:1');
  });
});
