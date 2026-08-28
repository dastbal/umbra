import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AGENT_DIR_NAME,
  LEGACY_AGENT_DIR_NAME,
  agentPath,
  migrateLegacyAgentDirectory,
} from './agent-directory';

describe('agentPath', () => {
  it('names one directory, so no caller can name a different one', () => {
    expect(agentPath('/project')).toBe(path.join('/project', AGENT_DIR_NAME));
    expect(agentPath('/project', 'backups')).toBe(
      path.join('/project', AGENT_DIR_NAME, 'backups'),
    );
    expect(agentPath('/project', 'telemetry', 'turns.jsonl')).toBe(
      path.join('/project', AGENT_DIR_NAME, 'telemetry', 'turns.jsonl'),
    );
  });

  it('is not the generic name other agents could claim', () => {
    // The rename is the point: `.agent/` says nothing about which agent owns it
    // on a machine running several side by side.
    expect(AGENT_DIR_NAME).toBe('.umbra');
    expect(AGENT_DIR_NAME).not.toBe(LEGACY_AGENT_DIR_NAME);
  });
});

describe('migrateLegacyAgentDirectory', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-migrate-'));
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  /** Creates a legacy workspace holding one identifiable file. */
  function seedLegacyWorkspace(marker = 'index.meta.json'): string {
    const legacyDir = path.join(projectDir, LEGACY_AGENT_DIR_NAME);
    fs.mkdirSync(path.join(legacyDir, 'telemetry'), { recursive: true });
    fs.writeFileSync(path.join(legacyDir, marker), '{"seeded":true}', 'utf-8');
    return legacyDir;
  }

  it('moves the legacy workspace and keeps what was inside it', () => {
    seedLegacyWorkspace();

    expect(migrateLegacyAgentDirectory(projectDir)).toEqual({ migrated: true });

    // A rename that drops the contents is data loss, not a rename: this is the
    // RAG index, the session history and the backups.
    expect(fs.existsSync(agentPath(projectDir, 'index.meta.json'))).toBe(true);
    expect(fs.existsSync(agentPath(projectDir, 'telemetry'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, LEGACY_AGENT_DIR_NAME))).toBe(false);
  });

  it('does nothing when there is no legacy workspace', () => {
    expect(migrateLegacyAgentDirectory(projectDir)).toEqual({
      migrated: false,
      reason: 'no-legacy-directory',
    });
    expect(fs.existsSync(agentPath(projectDir))).toBe(false);
  });

  it('leaves both alone when both exist, rather than picking one', () => {
    seedLegacyWorkspace();
    fs.mkdirSync(agentPath(projectDir), { recursive: true });
    fs.writeFileSync(agentPath(projectDir, 'current.json'), '{}', 'utf-8');

    expect(migrateLegacyAgentDirectory(projectDir)).toEqual({
      migrated: false,
      reason: 'both-exist',
    });

    // Two workspaces mean two session histories. Merging or overwriting could
    // discard work, so the operator decides.
    expect(fs.existsSync(path.join(projectDir, LEGACY_AGENT_DIR_NAME))).toBe(true);
    expect(fs.existsSync(agentPath(projectDir, 'current.json'))).toBe(true);
  });

  it('is safe to call on every start', () => {
    seedLegacyWorkspace();

    expect(migrateLegacyAgentDirectory(projectDir).migrated).toBe(true);
    expect(migrateLegacyAgentDirectory(projectDir)).toEqual({
      migrated: false,
      reason: 'no-legacy-directory',
    });
    expect(fs.existsSync(agentPath(projectDir, 'index.meta.json'))).toBe(true);
  });
});
