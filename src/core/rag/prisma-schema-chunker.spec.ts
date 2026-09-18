import { PrismaSchemaChunker } from './prisma-schema-chunker';

describe('PrismaSchemaChunker', () => {
  it('emits one labelled configuration chunk per model, retaining its database guarantees', () => {
    const source = [
      'generator client {',
      '  provider = "prisma-client-js"',
      '}',
      '',
      'model Payment {',
      '  id             String  @id @default(cuid())',
      '  idempotencyKey String? @unique',
      '  amount         Decimal @db.Decimal(10, 2)',
      '}',
    ].join('\n');

    const result = new PrismaSchemaChunker().analyze('prisma/schema.prisma', source, 'fixture-hash');

    expect(result.dependencies).toEqual([]);
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]).toMatchObject({
      type: 'config',
      content: expect.stringContaining('idempotencyKey String? @unique'),
      metadata: {
        startLine: 5,
        endLine: 9,
        className: 'Payment',
        artifactKind: 'prisma-schema',
      },
    });
  });

  it('keeps a nonempty schema indexable when it has no model blocks', () => {
    const source = 'datasource db {\n  provider = "mysql"\n}\n';

    const result = new PrismaSchemaChunker().analyze('prisma/schema.prisma', source, 'fixture-hash');

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]).toMatchObject({
      type: 'config',
      content: source,
      metadata: { startLine: 1, endLine: 3, artifactKind: 'prisma-schema' },
    });
  });
});
