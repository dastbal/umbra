import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NestChunker } from './chunker';

describe('NestChunker module fallback', () => {
  it('creates a durable file chunk for a valid classless TypeScript module', () => {
    const source = [
      'export function resolveRoot(input: string): string { return input.trim(); }',
      'export const enabled = true;',
    ].join('\n');

    const result = new NestChunker().analyze('src/project-root.ts', source, 'fixture-hash');

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]).toMatchObject({
      type: 'file',
      content: source,
      metadata: { startLine: 1, endLine: 2 },
    });
  });

  it('keeps whitespace-only sources chunkless so the indexer can record an intentional skip', () => {
    const result = new NestChunker().analyze('src/empty.ts', ' \n\t', 'fixture-hash');

    expect(result.chunks).toEqual([]);
  });
});

describe('NestChunker class signatures', () => {
  it('preserves the declaration semantics required to read a class context honestly', () => {
    const result = new NestChunker().analyze(
      'src/financing-port.ts',
      [
        "import { BaseError } from './base-error';",
        "import { Source } from './source';",
        '/** Port documentation belongs in metadata, not executable context. */',
        'export abstract class FinancingPort<T extends Source> extends BaseError implements Iterable<T> {',
        '  constructor(message: string) { super(message); }',
        '  abstract load(): Promise<T>;',
        '}',
      ].join('\n'),
      'fixture-hash',
    );

    const signature = result.chunks.find((chunk) => chunk.type === 'class_signature');

    expect(signature?.content).toContain(
      'export abstract class FinancingPort<T extends Source> extends BaseError implements Iterable<T> {',
    );
    expect(signature?.content).toContain('super(message);');
    expect(signature?.content).not.toContain("import { BaseError } from './base-error';");
    expect(signature?.content).not.toContain('Port documentation belongs in metadata');
    expect(signature?.metadata.documentation).toContain('Port documentation belongs in metadata');
  });
});

/**
 * `resolveModulePath` probes the real filesystem, so these need files that
 * exist. A temp root keeps them independent of this repository's own layout.
 */
describe('NestChunker dependency edges', () => {
  let rootDir: string;
  let chunker: NestChunker;

  beforeAll(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-chunker-'));
    fs.mkdirSync(path.join(rootDir, 'src', 'nested'), { recursive: true });
    for (const relative of [
      'src/imported.ts',
      'src/re-exported.ts',
      'src/named.ts',
      'src/nested/index.ts',
    ]) {
      fs.writeFileSync(path.join(rootDir, relative), 'export const marker = 1;\n');
    }
    chunker = new NestChunker(rootDir);
  });

  afterAll(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  const edgesFor = (source: string) =>
    chunker.analyze('src/barrel.ts', source, 'fixture-hash').dependencies;

  it('records an import as an import edge', () => {
    const edges = edgesFor("import { marker } from './imported';");

    expect(edges).toEqual([
      { sourcePath: 'src/barrel.ts', targetPath: 'src/imported.ts', relation: 'import' },
    ]);
  });

  // Measured at 0 of 48 on this repository before the export declarations were
  // visited: every genuine gap in the dependency graph was a re-export, and
  // `src/index.ts` — the published barrel — had no outbound edges at all.
  it('records `export * from` as a re-export edge, which used to produce nothing', () => {
    const edges = edgesFor("export * from './re-exported';");

    expect(edges).toEqual([
      { sourcePath: 'src/barrel.ts', targetPath: 'src/re-exported.ts', relation: 're-export' },
    ]);
  });

  it('records a named re-export too', () => {
    const edges = edgesFor("export { marker } from './named';");

    expect(edges).toEqual([
      { sourcePath: 'src/barrel.ts', targetPath: 'src/named.ts', relation: 're-export' },
    ]);
  });

  it('resolves a re-exported directory through its index file', () => {
    const edges = edgesFor("export * from './nested';");

    expect(edges).toEqual([
      { sourcePath: 'src/barrel.ts', targetPath: 'src/nested/index.ts', relation: 're-export' },
    ]);
  });

  it('ignores an export with no from clause, which re-exports nothing', () => {
    const edges = edgesFor('const marker = 1;\nexport { marker };');

    expect(edges).toEqual([]);
  });

  it('ignores an external package on either node kind', () => {
    expect(edgesFor("import { z } from 'zod';")).toEqual([]);
    expect(edgesFor("export * from '@langchain/core';")).toEqual([]);
  });

  it('ignores a relative specifier that names no file on disk', () => {
    expect(edgesFor("export * from './absent';")).toEqual([]);
  });

  // Added after the graph arm reported three gaps caused by a lazy-load fix in
  // `start-mcp-server.ts`. A module loaded on purpose at runtime is the
  // dependency a reader is least likely to find by eye.
  it('records a relative require as its own relation', () => {
    const edges = edgesFor("const mod = require('./imported');");

    expect(edges).toEqual([
      { sourcePath: 'src/barrel.ts', targetPath: 'src/imported.ts', relation: 'require' },
    ]);
  });

  it('records a relative dynamic import as its own relation', () => {
    const edges = edgesFor("const mod = await import('./imported');");

    expect(edges).toEqual([
      { sourcePath: 'src/barrel.ts', targetPath: 'src/imported.ts', relation: 'dynamic-import' },
    ]);
  });

  it('ignores an external package reached by require', () => {
    expect(edgesFor("const db = require('better-sqlite3');")).toEqual([]);
  });

  it('ignores a computed specifier, which has no static target to record', () => {
    expect(edgesFor('const name = "./imported";\nconst mod = require(name);')).toEqual([]);
  });

  // `typeof import('x')` is a type position, not a call. The tree held two of
  // these and a grep counted them as dynamic imports; they are not.
  it('ignores an import type position, which is not a call at all', () => {
    expect(edgesFor("type Fs = typeof import('./imported');")).toEqual([]);
  });

  it('keeps both edges when a file imports and re-exports different targets', () => {
    const edges = edgesFor(
      ["import { marker } from './imported';", "export * from './re-exported';"].join('\n'),
    );

    expect(edges).toEqual([
      { sourcePath: 'src/barrel.ts', targetPath: 'src/imported.ts', relation: 'import' },
      { sourcePath: 'src/barrel.ts', targetPath: 'src/re-exported.ts', relation: 're-export' },
    ]);
  });
});
