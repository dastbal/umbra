import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AGENT_LOCAL_STATE_IGNORES,
  ensureAgentStateIgnored,
  findTrackedAgentState,
} from './workspace-scaffold';

describe('ensureAgentStateIgnored', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-ignore-'));
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  /** Reads the project's `.gitignore`, or '' when it has none. */
  function readIgnore(): string {
    const target = path.join(projectDir, '.gitignore');
    return fs.existsSync(target) ? fs.readFileSync(target, 'utf-8') : '';
  }

  it('creates a .gitignore when the project has none', () => {
    const added = ensureAgentStateIgnored(projectDir);

    expect(added).toEqual([...AGENT_LOCAL_STATE_IGNORES]);
    for (const rule of AGENT_LOCAL_STATE_IGNORES) {
      expect(readIgnore()).toContain(rule);
    }
  });

  it('never ignores the guides and decision records, which are meant to be versioned', () => {
    ensureAgentStateIgnored(projectDir);

    // ADR-012 scaffolds `skills/` and `docs/adr/` into the consumer project
    // precisely so they are committed there. Ignoring them would silently undo
    // an accepted decision.
    expect(readIgnore()).not.toContain('skills');
    expect(readIgnore()).not.toContain('docs/adr');
  });

  it('appends without touching what the project already wrote', () => {
    const existing = 'node_modules\ndist\n.env\n';
    fs.writeFileSync(path.join(projectDir, '.gitignore'), existing, 'utf-8');

    ensureAgentStateIgnored(projectDir);

    expect(readIgnore().startsWith(existing)).toBe(true);
    expect(readIgnore()).toContain('.umbra/');
  });

  it('is idempotent — a second run adds nothing', () => {
    ensureAgentStateIgnored(projectDir);
    const afterFirst = readIgnore();

    expect(ensureAgentStateIgnored(projectDir)).toEqual([]);
    expect(readIgnore()).toBe(afterFirst);
  });

  it('treats a bare rule as already covering its trailing-slash form', () => {
    // `.agent` and `.agent/` mean the same thing to git, so a project that
    // already ignores one must not gain a duplicate of the other.
    fs.writeFileSync(path.join(projectDir, '.gitignore'), '.agent\n', 'utf-8');

    const added = ensureAgentStateIgnored(projectDir);

    expect(added).not.toContain('.agent/');
    expect(added).toContain('deep_agent_history.db');
  });

  it('adds only the rules that were missing', () => {
    fs.writeFileSync(
      path.join(projectDir, '.gitignore'),
      'interactive-turns.jsonl\n',
      'utf-8',
    );

    expect(ensureAgentStateIgnored(projectDir)).not.toContain('interactive-turns.jsonl');
  });

  it('separates its block when the file does not end in a newline', () => {
    fs.writeFileSync(path.join(projectDir, '.gitignore'), 'dist', 'utf-8');

    ensureAgentStateIgnored(projectDir);

    // Without the separator, the first rule would be glued onto `dist`.
    expect(readIgnore()).toContain('dist\n');
    expect(readIgnore()).not.toContain('dist.umbra');
  });
});

describe('findTrackedAgentState', () => {
  let projectDir: string;

  /** Runs a git command in the temp project, ignoring its output. */
  function git(...args: string[]): void {
    execFileSync('git', args, { cwd: projectDir, stdio: 'ignore' });
  }

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-tracked-'));
    git('init');
    git('config', 'user.email', 'spec@example.test');
    git('config', 'user.name', 'Spec');
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('reports nothing for a project that never committed agent state', () => {
    fs.writeFileSync(path.join(projectDir, 'index.ts'), 'export {};', 'utf-8');
    git('add', '.');
    git('commit', '-m', 'initial');

    expect(findTrackedAgentState(projectDir)).toEqual([]);
  });

  it('finds workspace files committed before the ignore rules existed', () => {
    // This is the case an ignore rule cannot fix: git keeps pushing a tracked
    // file no matter what `.gitignore` says.
    fs.mkdirSync(path.join(projectDir, '.umbra'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.umbra', 'index.meta.json'), '{}', 'utf-8');
    fs.writeFileSync(path.join(projectDir, 'deep_agent_history.db'), 'x', 'utf-8');
    git('add', '-A');
    git('commit', '-m', 'committed agent state');

    // The rules are added afterwards, exactly as a real upgrade would.
    ensureAgentStateIgnored(projectDir);

    const tracked = findTrackedAgentState(projectDir);
    expect(tracked).toContain('.umbra/index.meta.json');
    expect(tracked).toContain('deep_agent_history.db');
  });

  it('finds a committed legacy workspace too', () => {
    fs.mkdirSync(path.join(projectDir, '.agent', 'telemetry'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, '.agent', 'telemetry', 'interactive-turns.jsonl'),
      '{}\n',
      'utf-8',
    );
    git('add', '-A');
    git('commit', '-m', 'committed legacy workspace');

    expect(findTrackedAgentState(projectDir)).toContain(
      '.agent/telemetry/interactive-turns.jsonl',
    );
  });

  it('never reports the guides or decision records, which are meant to be tracked', () => {
    fs.mkdirSync(path.join(projectDir, 'skills'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'docs', 'adr'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'skills', 'write-tests.md'), '# x', 'utf-8');
    fs.writeFileSync(path.join(projectDir, 'docs', 'adr', 'README.md'), '# x', 'utf-8');
    git('add', '-A');
    git('commit', '-m', 'guides and records');

    expect(findTrackedAgentState(projectDir)).toEqual([]);
  });

  it('stays silent outside a git repository', () => {
    const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-nogit-'));
    try {
      expect(findTrackedAgentState(plainDir)).toEqual([]);
    } finally {
      fs.rmSync(plainDir, { recursive: true, force: true });
    }
  });
});
