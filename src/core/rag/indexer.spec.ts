import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { pinRuntimeRoot, resetRuntimeRoot } from '../config/runtime-root';
import { AgentDB } from '../state/db';
import { NestChunker } from '../tools/ast/chunker';
import { EmbeddingsPort } from './embeddings';
import { readIndexStamp } from './index-stamp';
import { IndexerService } from './indexer';

describe('IndexerService durable file outcomes', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-indexer-'));
    fs.mkdirSync(path.join(rootDir, 'src'));
    fs.writeFileSync(path.join(rootDir, 'package.json'), '{"name":"fixture"}', 'utf8');
    fs.writeFileSync(path.join(rootDir, 'tsconfig.json'), '{"include":["src/**/*.ts"]}', 'utf8');
    fs.writeFileSync(path.join(rootDir, 'src', 'sample.ts'), 'export const sample = 1;\n', 'utf8');
    pinRuntimeRoot(rootDir);
    IndexerService.silent = true;
  });

  afterEach(() => {
    AgentDB.close();
    resetRuntimeRoot();
    IndexerService.silent = false;
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('leaves a provider-failed file pending instead of recording it as fresh', async () => {
    const indexer = new IndexerService(failingEmbeddings());

    const result = await indexer.indexProject();
    const db = new Database(path.join(rootDir, '.umbra', 'memory.db'), { readonly: true });
    const files = db.prepare('SELECT COUNT(*) AS total FROM file_registry').get() as { total: number };
    db.close();

    expect(result).toMatchObject({ disposition: 'completed', status: 'partial', filesIndexed: 0 });
    expect(files.total).toBe(0);
    expect(readIndexStamp(rootDir)).toMatchObject({ status: 'partial', coveredFiles: 0 });
  });

  it('never records nonempty zero-chunk input as fresh', async () => {
    const indexer = new IndexerService(successfulEmbeddings());
    replaceChunker(indexer, []);

    const result = await indexer.indexProject();
    const db = new Database(path.join(rootDir, '.umbra', 'memory.db'), { readonly: true });
    const files = db.prepare('SELECT COUNT(*) AS total FROM file_registry').get() as { total: number };
    db.close();

    expect(result).toMatchObject({ status: 'partial', filesIndexed: 0 });
    expect(files.total).toBe(0);
  });

  it('commits chunks and vectors for a classless TypeScript module', async () => {
    fs.writeFileSync(
      path.join(rootDir, 'src', 'sample.ts'),
      'export function resolveRoot(value: string): string { return value.trim(); }\n',
      'utf8',
    );
    const indexer = new IndexerService(successfulEmbeddings());

    const result = await indexer.indexProject();
    const db = new Database(path.join(rootDir, '.umbra', 'memory.db'), { readonly: true });
    const chunks = db.prepare('SELECT COUNT(*) AS total FROM code_chunks').get() as { total: number };
    const vectors = db.prepare('SELECT COUNT(*) AS total FROM chunk_vectors').get() as { total: number };
    db.close();

    expect(result).toMatchObject({ status: 'complete', filesIndexed: 1 });
    expect(chunks.total).toBeGreaterThan(0);
    expect(vectors.total).toBe(chunks.total);
    expect(readIndexStamp(rootDir)).toMatchObject({ status: 'complete', coveredFiles: 1 });
  });

  it('commits Prisma constraints as labelled configuration evidence', async () => {
    fs.mkdirSync(path.join(rootDir, 'prisma'));
    fs.writeFileSync(path.join(rootDir, 'prisma', 'schema.prisma'), [
      'model Payment {',
      '  idempotencyKey String? @unique',
      '  amount Decimal @db.Decimal(10, 2)',
      '}',
    ].join('\n'), 'utf8');
    const indexer = new IndexerService(successfulEmbeddings());

    const result = await indexer.indexProject();
    const db = new Database(path.join(rootDir, '.umbra', 'memory.db'), { readonly: true });
    const chunk = db.prepare(
      "SELECT chunk_type AS type, content, metadata FROM code_chunks WHERE file_path = 'prisma/schema.prisma'",
    ).get() as { type: string; content: string; metadata: string };
    db.close();

    expect(result).toMatchObject({ status: 'complete', filesIndexed: 2 });
    expect(chunk.type).toBe('config');
    expect(chunk.content).toContain('idempotencyKey String? @unique');
    expect(JSON.parse(chunk.metadata)).toMatchObject({ className: 'Payment', artifactKind: 'prisma-schema' });
    expect(readIndexStamp(rootDir)).toMatchObject({ status: 'complete', coveredFiles: 2 });
  });

  it('persists an explicit skipped outcome for intentionally empty source', async () => {
    fs.writeFileSync(path.join(rootDir, 'src', 'sample.ts'), ' \n\t', 'utf8');
    const indexer = new IndexerService(successfulEmbeddings());
    replaceChunker(indexer, []);

    const result = await indexer.indexProject();
    const db = new Database(path.join(rootDir, '.umbra', 'memory.db'), { readonly: true });
    const row = db.prepare('SELECT index_state AS state, skip_reason AS reason FROM file_registry').get() as {
      state: string;
      reason: string;
    };
    db.close();

    expect(result).toMatchObject({ status: 'complete', filesIndexed: 0 });
    expect(row).toEqual({ state: 'skipped', reason: 'empty-or-whitespace source' });
    expect(readIndexStamp(rootDir)).toMatchObject({ coveredFiles: 1, filesIndexed: 0 });
  });
});

/** Makes an embedding provider whose indexing calls always fail. */
function failingEmbeddings(): EmbeddingsPort {
  return {
    identity: { provider: 'ollama', model: 'fixture', dimensions: 3, column: 'vector_ollama_json' },
    embedQuery: async () => [0, 0, 0],
    embedDocuments: async () => Promise.reject(new Error('Ollama fixture failure')),
  };
}

/** Makes an embedding provider that returns one valid vector per input. */
function successfulEmbeddings(): EmbeddingsPort {
  return {
    identity: { provider: 'ollama', model: 'fixture', dimensions: 3, column: 'vector_ollama_json' },
    embedQuery: async () => [0, 0, 0],
    embedDocuments: async (texts) => texts.map(() => [1, 2, 3]),
  };
}

/** Replaces the parser in this narrow fixture to make the zero-chunk boundary deterministic. */
function replaceChunker(indexer: IndexerService, chunks: readonly []): void {
  const privateIndexer = indexer as unknown as { chunker: NestChunker };
  privateIndexer.chunker = {
    analyze: () => ({ chunks, dependencies: [], skeleton: null }),
  } as unknown as NestChunker;
}
