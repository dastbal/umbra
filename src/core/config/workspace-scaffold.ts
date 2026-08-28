import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { AGENT_DIR_NAME, LEGACY_AGENT_DIR_NAME } from './agent-directory';

/**
 * Marker file used to identify the packaged skill library.
 *
 * Any directory containing this file is the shipped `skills/` directory, both
 * when running from source (`src/`) and from the published build (`dist/`).
 */
const SKILL_LIBRARY_MARKER = 'document-decision.md';

/** Outcome of scaffolding the working guides into a target project. */
export interface WorkspaceScaffoldResult {
  /** Absolute path of the target project's `skills` directory. */
  skillsPath: string;
  /** Absolute path of the target project's `docs/adr` directory. */
  adrPath: string;
  /** Skill file names written by this invocation. */
  installedSkills: string[];
  /** Skill file names left untouched because the project already had them. */
  preservedSkills: string[];
  /** Whether this invocation created the ADR index. */
  createdAdrIndex: boolean;
  /** Ignore rules added to the project's `.gitignore` by this invocation. */
  addedIgnoreRules: string[];
  /**
   * Agent state git already tracks, which no ignore rule can stop.
   *
   * Untracking is the operator's call — see {@link findTrackedAgentState}.
   */
  trackedAgentState: string[];
}

/**
 * Machine-local agent state that must never reach the consumer's repository.
 *
 * Deliberately narrow. `skills/` and `docs/adr/` are **not** here: ADR-012
 * decided that the shipped working guides and the decision-record index are
 * scaffolded into the consumer project *to be versioned there*, so ignoring
 * them would quietly undo an accepted decision. What is listed is only what a
 * second machine would regenerate anyway — session history, the RAG index, and
 * the vector store.
 */
export const AGENT_LOCAL_STATE_IGNORES: readonly string[] = [
  `${AGENT_DIR_NAME}/`,
  // The pre-rename workspace is still ignored. A project that has not been
  // started since the rename still holds one, and it must not be committed in
  // the window before the migration moves it.
  `${LEGACY_AGENT_DIR_NAME}/`,
  'deep_agent_history.db',
  'deep_agent_history.db-shm',
  'deep_agent_history.db-wal',
  'interactive-turns.jsonl',
] as const;

/** Header that marks Umbra's block in a consumer `.gitignore`. */
const IGNORE_BLOCK_HEADER = '# Umbra — local agent state (safe to delete)';

/**
 * Adds the agent's local-state rules to the project's `.gitignore`.
 *
 * Running `umbra init` left roughly two dozen untracked files in the consumer's
 * working tree — session databases, the RAG index, write-ahead logs — all of
 * which regenerate on their own and none of which mean anything on another
 * machine. Committing them was the default outcome of the next `git add -A`.
 *
 * Only missing rules are appended, and nothing already in the file is rewritten
 * or reordered: a `.gitignore` is the consumer's file, not ours. A project
 * without one gets a new file containing only this block.
 *
 * @param rootDir - Absolute path of the target project.
 * @returns The rules actually added, empty when everything was already ignored.
 */
export function ensureAgentStateIgnored(rootDir: string): string[] {
  const ignorePath = path.join(rootDir, '.gitignore');

  let existing = '';
  try {
    if (fs.existsSync(ignorePath)) existing = fs.readFileSync(ignorePath, 'utf-8');
  } catch {
    return [];
  }

  const present = new Set(
    existing
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#')),
  );

  // A trailing-slash rule and its bare form mean the same thing to git, so a
  // project that already ignores `.agent` must not gain a second `.agent/`.
  const missing = AGENT_LOCAL_STATE_IGNORES.filter(
    (rule) => !present.has(rule) && !present.has(rule.replace(/\/$/, '')),
  );
  if (missing.length === 0) return [];

  const separator = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  const block = `${separator}\n${IGNORE_BLOCK_HEADER}\n${missing.join('\n')}\n`;

  try {
    fs.appendFileSync(ignorePath, block, 'utf-8');
  } catch {
    return [];
  }

  return [...missing];
}

/**
 * Reports agent state that git already tracks, which an ignore rule cannot stop.
 *
 * `.gitignore` only governs **untracked** files. A project that committed its
 * workspace before the ignore rules existed keeps pushing it on every commit,
 * and the new rules are silently powerless — session databases and the RAG index
 * would keep travelling to the remote.
 *
 * Detection only. Untracking is `git rm --cached`, which rewrites the index and,
 * once committed, deletes the file for every teammate who pulls. That is the
 * operator's decision, not an installer's.
 *
 * @param rootDir - Absolute path of the target project.
 * @returns Tracked paths matching the agent-state rules; empty when none, when
 *   the project is not a git repository, or when git is unavailable.
 */
export function findTrackedAgentState(rootDir: string): string[] {
  let tracked = '';
  try {
    tracked = execFileSync('git', ['ls-files'], {
      cwd: rootDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    // Not a git repository, or git is not installed. Nothing to warn about.
    return [];
  }

  const bareNames = AGENT_LOCAL_STATE_IGNORES.map((rule) => rule.replace(/\/$/, ''));

  return tracked
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) =>
      bareNames.some(
        (name) =>
          // A directory rule matches everything beneath it; a file rule matches
          // the file at any depth, which is how git reads a slash-less pattern.
          line === name || line.startsWith(`${name}/`) || line.endsWith(`/${name}`),
      ),
    );
}

/**
 * Locates the skill library shipped inside this package.
 *
 * The lookup walks upward from the compiled (or transpiled) module location
 * rather than from `process.cwd()`, because the consumer's working directory is
 * the project being worked on, not the installed package.
 *
 * @param startDir - Directory to start the upward walk from.
 * @returns Absolute path of the packaged `skills` directory, or `null` when the
 *   package was installed without it.
 */
export function resolvePackagedSkillsDir(startDir: string = __dirname): string | null {
  let current = path.resolve(startDir);

  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = path.join(current, 'skills');
    if (fs.existsSync(path.join(candidate, SKILL_LIBRARY_MARKER))) return candidate;

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return null;
}

/**
 * Installs the agent's working guides into a target project.
 *
 * Only top-level `.md` files are copied. Subdirectories of the packaged library
 * are deliberately excluded: they hold guides for developing this agent itself,
 * which are of no use inside a consumer project.
 *
 * The operation is idempotent and never overwrites a file the project already
 * has, so a team can edit an installed guide without a later `init` reverting it.
 *
 * @param rootDir - Root of the project that receives the guides.
 * @param packagedSkillsDir - Source library; resolved from the package by default.
 * @returns Which guides were installed, which were preserved, and where.
 * @throws {Error} When the packaged skill library cannot be located.
 */
export function ensureWorkspaceSkills(
  rootDir: string,
  packagedSkillsDir: string | null = resolvePackagedSkillsDir(),
): WorkspaceScaffoldResult {
  if (!packagedSkillsDir) {
    throw new Error(
      'Packaged skill library not found; the installed package is missing its "skills" directory.',
    );
  }

  const resolvedRoot = path.resolve(rootDir);
  const skillsPath = path.join(resolvedRoot, 'skills');
  const adrPath = path.join(resolvedRoot, 'docs', 'adr');

  const installedSkills: string[] = [];
  const preservedSkills: string[] = [];

  if (path.resolve(packagedSkillsDir) !== skillsPath) {
    fs.mkdirSync(skillsPath, { recursive: true });

    for (const entry of fs.readdirSync(packagedSkillsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;

      const target = path.join(skillsPath, entry.name);
      if (fs.existsSync(target)) {
        preservedSkills.push(entry.name);
        continue;
      }

      fs.copyFileSync(path.join(packagedSkillsDir, entry.name), target);
      installedSkills.push(entry.name);
    }
  } else {
    for (const entry of fs.readdirSync(packagedSkillsDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) preservedSkills.push(entry.name);
    }
  }

  const createdAdrIndex = ensureAdrIndex(adrPath);

  return {
    skillsPath,
    adrPath,
    installedSkills: installedSkills.sort(),
    preservedSkills: preservedSkills.sort(),
    createdAdrIndex,
    addedIgnoreRules: ensureAgentStateIgnored(resolvedRoot),
    trackedAgentState: findTrackedAgentState(resolvedRoot),
  };
}

/**
 * Creates the decision-record directory and its index when absent.
 *
 * The index is what makes `list_adrs` cheap to act on: a future agent reads the
 * table, matches tags, and opens only the relevant record.
 *
 * @param adrPath - Absolute path of the target project's `docs/adr` directory.
 * @returns Whether the index file was created by this invocation.
 */
function ensureAdrIndex(adrPath: string): boolean {
  fs.mkdirSync(adrPath, { recursive: true });

  const indexPath = path.join(adrPath, 'README.md');
  if (fs.existsSync(indexPath)) return false;

  fs.writeFileSync(indexPath, ADR_INDEX_TEMPLATE, { encoding: 'utf8', flag: 'wx' });
  return true;
}

/** Empty index seeded on initialization; rows are appended per decision. */
const ADR_INDEX_TEMPLATE = `# Architectural Decision Records

Index of every decision record in this project. **Read this table first**, match
your task against the \`Tags\` column, and open only the records that match.
Reading all of them costs a lot of context and is only warranted on an explicit
deep audit.

When a record and the code disagree: the **code** is authoritative for what the
system does now, the **record** for why it was built that way. A disagreement
means the record needs an amendment — flag it instead of silently picking a side.

| ADR | Status | Tags | Decision |
|---|---|---|---|
`;
