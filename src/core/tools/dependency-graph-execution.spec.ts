import Database from 'better-sqlite3';
import { executeDependencyGraph } from './read-only-executions';

describe('dependency graph file coverage', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE file_registry (path TEXT PRIMARY KEY);
      CREATE TABLE dependency_graph (source TEXT, target TEXT, relation TEXT);
      INSERT INTO file_registry VALUES ('src/infrastructure/zoho/zoho-workdrive-http.service.ts');
    `);
  });

  afterEach(() => db.close());

  it('distinguishes an unindexed guessed path from a file with no importers', () => {
    const result = executeDependencyGraph({
      filePath: 'src/module/zoho/zoho-workdrive-http.service.ts',
      direction: 'inbound',
    }, { db });

    expect(result).toMatchObject({
      code: 'FILE_NOT_INDEXED',
      status: 'empty',
      data: {
        suggestedPaths: ['src/infrastructure/zoho/zoho-workdrive-http.service.ts'],
      },
    });
  });

  it('keeps NO_DEPENDENCIES for an indexed file with no edges', () => {
    const result = executeDependencyGraph({
      filePath: 'src/infrastructure/zoho/zoho-workdrive-http.service.ts',
      direction: 'inbound',
    }, { db });

    expect(result.code).toBe('NO_DEPENDENCIES');
  });
});
