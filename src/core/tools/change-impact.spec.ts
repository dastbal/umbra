import Database from 'better-sqlite3';
import { executeChangeImpact } from './read-only-executions';

describe('change impact', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE file_registry (path TEXT PRIMARY KEY);
      CREATE TABLE dependency_graph (source TEXT, target TEXT, relation TEXT);
      CREATE TABLE code_chunks (file_path TEXT, metadata TEXT);
      CREATE TABLE nest_injections (file_path TEXT, consumer TEXT, token TEXT, explicit INTEGER);
      CREATE TABLE nest_bindings (file_path TEXT, module TEXT, kind TEXT, token TEXT, use_kind TEXT, dynamic INTEGER);
      INSERT INTO file_registry VALUES ('src/payment.service.ts');
      INSERT INTO file_registry VALUES ('src/payment.controller.ts');
      INSERT INTO file_registry VALUES ('src/payment.module.ts');
      INSERT INTO file_registry VALUES ('src/checkout.service.ts');
      INSERT INTO file_registry VALUES ('src/app.module.ts');
      INSERT INTO dependency_graph VALUES ('src/payment.controller.ts', 'src/payment.service.ts', 'imports');
      INSERT INTO dependency_graph VALUES ('src/payment.module.ts', 'src/payment.controller.ts', 'imports');
      INSERT INTO code_chunks VALUES ('src/payment.service.ts', '{"className":"PaymentService"}');
      INSERT INTO nest_injections VALUES ('src/checkout.service.ts', 'CheckoutService', 'PaymentService', 0);
      INSERT INTO nest_bindings VALUES ('src/app.module.ts', 'AppModule', 'provider', 'PaymentService', 'class', 0);
    `);
  });

  afterEach(() => db.close());

  it('answers import and Nest injection impact in one bounded call', () => {
    const result = executeChangeImpact({ filePath: 'src/payment.service.ts', depth: 2 }, { db });
    expect(result.code).toBe('IMPACT_FOUND');
    expect(result.data.affected).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'src/payment.controller.ts', kind: 'import', depth: 1 }),
      expect.objectContaining({ path: 'src/payment.module.ts', kind: 'import', depth: 2 }),
      expect.objectContaining({ path: 'src/checkout.service.ts', kind: 'injection', token: 'PaymentService' }),
      expect.objectContaining({ path: 'src/app.module.ts', kind: 'binding', token: 'PaymentService' }),
    ]));
  });

  it('does not call an absent file unaffected', () => {
    const result = executeChangeImpact({ filePath: 'src/unknown.service.ts', depth: 2 }, { db });
    expect(result.code).toBe('FILE_NOT_INDEXED');
  });

  it('stops at the requested depth even when imports contain a cycle', () => {
    db.exec("INSERT INTO dependency_graph VALUES ('src/payment.service.ts', 'src/payment.module.ts', 'imports')");
    const result = executeChangeImpact({ filePath: 'src/payment.service.ts', depth: 1 }, { db });
    expect(result.data.affected.filter((entry) => entry.kind === 'import').map((entry) => entry.path))
      .toEqual(['src/payment.controller.ts']);
  });

  it('bounds a wide importer graph and labels the partial answer', () => {
    const insert = db.prepare('INSERT INTO dependency_graph VALUES (?, ?, ?)');
    for (let i = 0; i < 110; i++) insert.run(`src/importer-${i}.ts`, 'src/payment.service.ts', 'imports');
    const result = executeChangeImpact({ filePath: 'src/payment.service.ts' }, { db });
    expect(result).toMatchObject({ code: 'IMPACT_FOUND', status: 'partial', truncated: true });
    expect(result.data.affected.length).toBeLessThanOrEqual(100);
  });
});
