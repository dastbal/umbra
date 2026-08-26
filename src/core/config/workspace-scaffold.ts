import * as fs from 'fs';
import * as path from 'path';

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
