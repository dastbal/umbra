import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildAdrIndex,
  formatAdrIndex,
} from './adr-index';

describe('ADR index', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nestjs-agent-adrs-'));
    fs.mkdirSync(path.join(rootDir, 'docs', 'adr'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('indexes ADR title, status, and compact context without returning bodies', () => {
    fs.writeFileSync(
      path.join(rootDir, 'docs', 'adr', 'ADR-002-routing.md'),
      '# ADR-002: Model routing\n\n## Estado\n\nAceptada - 2026-08-07\n\n## Contexto\n\nRoute models by role to reduce cost.\n\nLong body that must not be returned.\n',
    );
    fs.writeFileSync(path.join(rootDir, 'docs', 'adr', 'notes.md'), '# Not an ADR\n');

    const index = buildAdrIndex(rootDir);
    const output = formatAdrIndex(index);

    expect(index.status).toBe('rebuilt');
    expect(index.entries).toEqual([
      expect.objectContaining({
        id: 'ADR-002',
        path: 'docs/adr/ADR-002-routing.md',
        title: 'Model routing',
        statusLabel: 'Aceptada - 2026-08-07',
        context: 'Route models by role to reduce cost.',
      }),
    ]);
    expect(output).not.toContain('Long body');
    expect(output).not.toContain('notes.md');
    expect(fs.existsSync(path.join(rootDir, '.agent', 'adr-index.json'))).toBe(true);
  });

  it('reuses the cache until an ADR changes', () => {
    const adrPath = path.join(rootDir, 'docs', 'adr', 'ADR-001-context.md');
    fs.writeFileSync(adrPath, '# ADR-001: Context\n\n## Estado\n\nPropuesta\n');

    expect(buildAdrIndex(rootDir).status).toBe('rebuilt');
    expect(buildAdrIndex(rootDir).status).toBe('cached');

    fs.writeFileSync(adrPath, '# ADR-001: Context\n\n## Estado\n\nAceptada\n');
    fs.utimesSync(adrPath, new Date(), new Date(Date.now() + 1_000));

    const refreshed = buildAdrIndex(rootDir);
    expect(refreshed.status).toBe('rebuilt');
    expect(refreshed.entries[0].statusLabel).toBe('Aceptada');
  });
});
