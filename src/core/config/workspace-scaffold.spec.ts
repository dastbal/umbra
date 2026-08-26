import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  ensureWorkspaceSkills,
  resolvePackagedSkillsDir,
} from './workspace-scaffold';

describe('workspace scaffold', () => {
  let target: string;
  let library: string;

  beforeEach(() => {
    target = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-target-'));
    library = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-library-'));

    fs.writeFileSync(path.join(library, 'document-decision.md'), '# adr guide\n');
    fs.writeFileSync(path.join(library, 'write-tests.md'), '# tests guide\n');
    fs.writeFileSync(path.join(library, 'not-a-guide.txt'), 'ignored\n');
    fs.mkdirSync(path.join(library, 'run-nestjs-ai-agent'));
    fs.writeFileSync(
      path.join(library, 'run-nestjs-ai-agent', 'SKILL.md'),
      '# internal only\n',
    );
  });

  afterEach(() => {
    fs.rmSync(target, { recursive: true, force: true });
    fs.rmSync(library, { recursive: true, force: true });
  });

  it('installs the guides and seeds the decision-record index', () => {
    const result = ensureWorkspaceSkills(target, library);

    expect(result.installedSkills).toEqual(['document-decision.md', 'write-tests.md']);
    expect(result.preservedSkills).toEqual([]);
    expect(result.createdAdrIndex).toBe(true);

    const index = fs.readFileSync(path.join(target, 'docs', 'adr', 'README.md'), 'utf8');
    expect(index).toContain('| ADR | Status | Tags | Decision |');
  });

  it('excludes non-markdown files and the internal development guides', () => {
    ensureWorkspaceSkills(target, library);

    const installed = fs.readdirSync(path.join(target, 'skills'));
    expect(installed).not.toContain('not-a-guide.txt');
    expect(installed).not.toContain('run-nestjs-ai-agent');
  });

  it('never overwrites a guide the project already edited', () => {
    const edited = path.join(target, 'skills', 'write-tests.md');
    fs.mkdirSync(path.dirname(edited), { recursive: true });
    fs.writeFileSync(edited, '# team-owned version\n');

    const result = ensureWorkspaceSkills(target, library);

    expect(result.installedSkills).toEqual(['document-decision.md']);
    expect(result.preservedSkills).toEqual(['write-tests.md']);
    expect(fs.readFileSync(edited, 'utf8')).toBe('# team-owned version\n');
  });

  it('is idempotent and preserves an existing decision-record index', () => {
    ensureWorkspaceSkills(target, library);
    const indexPath = path.join(target, 'docs', 'adr', 'README.md');
    fs.appendFileSync(indexPath, '| [001](./ADR-001-x.md) | Accepted | `x` | Something. |\n');

    const second = ensureWorkspaceSkills(target, library);

    expect(second.installedSkills).toEqual([]);
    expect(second.createdAdrIndex).toBe(false);
    expect(fs.readFileSync(indexPath, 'utf8')).toContain('ADR-001-x.md');
  });

  it('reports the guides as preserved when the target is the library itself', () => {
    const selfHosted = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-self-'));
    const ownSkills = path.join(selfHosted, 'skills');
    fs.mkdirSync(ownSkills);
    fs.writeFileSync(path.join(ownSkills, 'document-decision.md'), '# canonical\n');

    const result = ensureWorkspaceSkills(selfHosted, ownSkills);

    expect(result.installedSkills).toEqual([]);
    expect(result.preservedSkills).toEqual(['document-decision.md']);
    expect(fs.readFileSync(path.join(ownSkills, 'document-decision.md'), 'utf8')).toBe(
      '# canonical\n',
    );

    fs.rmSync(selfHosted, { recursive: true, force: true });
  });

  it('fails loudly when the package shipped without its guides', () => {
    expect(() => ensureWorkspaceSkills(target, null)).toThrow(
      /missing its "skills" directory/,
    );
  });

  it('resolves the guide library shipped with this package', () => {
    const resolved = resolvePackagedSkillsDir();

    expect(resolved).not.toBeNull();
    expect(fs.existsSync(path.join(resolved as string, 'document-decision.md'))).toBe(true);
  });

  it('returns null when no ancestor directory ships a guide library', () => {
    expect(resolvePackagedSkillsDir(target)).toBeNull();
  });
});
