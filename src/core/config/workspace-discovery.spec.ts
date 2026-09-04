import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  WorkspaceDiscoveryError,
  WorkspaceDiscoveryService,
} from './workspace-discovery';

describe('WorkspaceDiscoveryService', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-workspace-'));
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('discovers declared TypeScript and TSX files in a monorepo without a root src directory', () => {
    write('pnpm-workspace.yaml', 'packages:\n  - apps/*\n  - packages/*\n');
    write('apps/api/tsconfig.json', JSON.stringify({ include: ['src/**/*.ts'] }));
    write('apps/web/tsconfig.json', JSON.stringify({ include: ['features/**/*.tsx'] }));
    write('packages/shared/tsconfig.json', JSON.stringify({ include: ['src/**/*'] }));
    write('apps/api/src/main.ts', 'export const api = true;');
    write('apps/web/features/page.tsx', 'export const Page = () => null;');
    write('packages/shared/src/value.ts', 'export const value = 1;');
    write('apps/api/src/main.spec.ts', 'test("ignored", () => undefined);');
    write('apps/web/features/view.stories.tsx', 'export const Story = {};');
    write('packages/shared/src/types.d.ts', 'declare const ignored: string;');
    write('node_modules/noise.ts', 'export const noise = true;');
    write('apps/api/.next/generated.ts', 'export const generated = true;');

    const result = new WorkspaceDiscoveryService(rootDir).discover();

    expect(result.sourceFiles.map((file) => file.relativePath)).toEqual([
      'apps/api/src/main.ts',
      'apps/web/features/page.tsx',
      'packages/shared/src/value.ts',
    ]);
    expect(result.typeScriptProjects.map((project) => project.relativePath)).toEqual([
      'apps/api/tsconfig.json',
      'apps/web/tsconfig.json',
      'packages/shared/tsconfig.json',
    ]);
  });

  it('keeps the src fallback for an undeclared single-package repository', () => {
    write('src/service.ts', 'export class Service {}');

    const result = new WorkspaceDiscoveryService(rootDir).discover();

    expect(result.sourceFiles.map((file) => file.relativePath)).toEqual(['src/service.ts']);
    expect(result.sourceOrigin).toBe('legacy-src');
  });

  it('uses the version-controlled source override instead of automatic discovery', () => {
    write('umbra.json', JSON.stringify({ indexing: { sources: ['custom/**/*.ts'] } }));
    write('custom/visible.ts', 'export const visible = true;');
    write('src/hidden.ts', 'export const hidden = true;');

    const result = new WorkspaceDiscoveryService(rootDir).discover();

    expect(result.sourceOrigin).toBe('config');
    expect(result.sourceFiles.map((file) => file.relativePath)).toEqual(['custom/visible.ts']);
  });

  it('fails with an actionable diagnostic instead of assuming an embedding problem', () => {
    expect(() => new WorkspaceDiscoveryService(rootDir).discover()).toThrow(WorkspaceDiscoveryError);
    expect(() => new WorkspaceDiscoveryService(rootDir).discover()).toThrow('No indexable source files');
  });

  it('discovers module ADR catalogs and retains README metadata', () => {
    write('src/anchor.ts', 'export const anchor = true;');
    write('docs/payments/adr/README.md', [
      '| ID | Title | Status | Tags | Summary |',
      '| --- | --- | --- | --- | --- |',
      '| [ADR_001](./ADR_001_SETTLEMENT.md) | Settlement | Accepted | payments, first | A curated summary |',
    ].join('\n'));
    write('docs/payments/adr/ADR_001_SETTLEMENT.md', '# ADR-001 — body fallback must not win');
    write('docs/adr/ADR-002-routing.md', '# ADR-002: Routing\n\n## Status\n\nAccepted\n\n## Context\n\nFallback body.');

    const result = new WorkspaceDiscoveryService(rootDir).discover();

    expect(result.adrCatalogs.map((catalog) => catalog.module)).toEqual(['root', 'payments']);
    expect(result.adrCatalogs[1]?.readmePath).toBe('docs/payments/adr/README.md');
  });

  function write(relativePath: string, content: string): void {
    const target = path.join(rootDir, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  }
});
