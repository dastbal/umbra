import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AGENT_DIR_NAME } from '../config/agent-directory';
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

  // The parser recognised only the Spanish headings the first four records
  // used. Every record from ADR-005 on is in English, as the project convention
  // requires, so 16 of 20 reported `Sin estado` and `Sin contexto` to
  // `list_adrs`: the agent could read their titles and nothing else.
  it('reads status and context from English headings as well as Spanish ones', () => {
    fs.writeFileSync(
      path.join(rootDir, 'docs', 'adr', 'ADR-019-turn-cost.md'),
      '# ADR-019: A turn is bounded by what it costs\n\n## Status\n\nAccepted\n\n## Context\n\nTool execution was 1.4% of recorded elapsed time.\n\nLong body that must not be returned.\n',
    );
    fs.writeFileSync(
      path.join(rootDir, 'docs', 'adr', 'ADR-002-routing.md'),
      '# ADR-002: Model routing\n\n## Estado\n\nAceptada - 2026-08-07\n\n## Contexto\n\nRoute models by role.\n',
    );

    const entries = buildAdrIndex(rootDir).entries;

    expect(entries).toEqual([
      expect.objectContaining({
        id: 'ADR-002',
        statusLabel: 'Aceptada - 2026-08-07',
        context: 'Route models by role.',
      }),
      expect.objectContaining({
        id: 'ADR-019',
        statusLabel: 'Accepted',
        context: 'Tool execution was 1.4% of recorded elapsed time.',
      }),
    ]);
    expect(entries.some((entry) => entry.statusLabel === 'Sin estado')).toBe(false);
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
    expect(fs.existsSync(path.join(rootDir, AGENT_DIR_NAME, 'adr-index.json'))).toBe(true);
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

  it('prefers metadata from a module catalog README over re-derived ADR body text', () => {
    const catalog = path.join(rootDir, 'docs', 'payments', 'adr');
    fs.mkdirSync(catalog, { recursive: true });
    fs.writeFileSync(
      path.join(catalog, 'README.md'),
      '| ID | Title | Status | Tags | Summary |\n| --- | --- | --- | --- | --- |\n| [ADR_001](./ADR_001_SETTLEMENT.md) | Settlement workflow | Accepted | payments | Curated summary |\n',
    );
    fs.writeFileSync(path.join(catalog, 'ADR_001_SETTLEMENT.md'), '# ADR-001 — stale body title');

    const entry = buildAdrIndex(rootDir).entries.find((candidate) => candidate.module === 'payments');

    expect(entry).toEqual(expect.objectContaining({
      id: 'ADR-001', title: 'Settlement workflow', statusLabel: 'Accepted', context: 'Curated summary',
    }));
  });
});
