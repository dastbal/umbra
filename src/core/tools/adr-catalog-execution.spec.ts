import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { executeListAdrs } from './read-only-executions';

describe('bounded ADR catalog answers', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-adr-page-'));
    const directory = path.join(root, 'docs', 'adr');
    fs.mkdirSync(directory, { recursive: true });
    for (let i = 1; i <= 35; i++) {
      const number = String(i).padStart(3, '0');
      fs.writeFileSync(path.join(directory, `ADR-${number}-decision.md`),
        `# ADR-${number}: Decision ${number}\n\n## Status\n\nAccepted\n\n## Context\n\nDecision ${number} concerns payments.\n`);
    }
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('returns a small first page with counts and a continuation', () => {
    const first = executeListAdrs({}, root);
    expect(first).toMatchObject({
      code: 'ADR_CATALOG_READY',
      data: { total: 35, nextOffset: 10, moduleCounts: [{ module: 'root', count: 35 }] },
      truncated: true,
    });
    expect(first.data.entries).toHaveLength(10);
    const second = executeListAdrs({ offset: first.data.nextOffset }, root);
    expect(second.data.entries[0].id).toBe('ADR-011');
  });

  it('filters titles before paginating', () => {
    const result = executeListAdrs({ query: 'Decision 025', limit: 5 }, root);
    expect(result.data.total).toBe(1);
    expect(result.data.entries.map((entry) => entry.id)).toEqual(['ADR-025']);
    expect(result.truncated).toBe(false);
  });

  it('filters tags from a human-maintained INDEX.md', () => {
    fs.writeFileSync(path.join(root, 'docs', 'adr', 'INDEX.md'), [
      '| ADR | Title | Status | Date | Tags |',
      '| --- | --- | --- | --- | --- |',
      '| [ADR-025](ADR-025-decision.md) | Decision 025 | Accepted | 2026-11-03 | `financing`, `crm-events` |',
    ].join('\n'));

    const result = executeListAdrs({ tags: ['crm-events'] }, root);
    expect(result.data.entries.map((entry) => entry.id)).toEqual(['ADR-025']);
    expect(result.data.entries[0].tags).toEqual(['financing', 'crm-events']);
    const moduleResult = executeListAdrs({ module: 'crm-events' }, root);
    expect(moduleResult.code).toBe('ADR_CATALOG_READY');
    expect(moduleResult.data.entries.map((entry) => entry.id)).toEqual(['ADR-025']);
  });
});
