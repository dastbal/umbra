/**
 * @module AgentDirectory
 *
 * The one place that names Umbra's workspace directory.
 *
 * ## Why this module exists
 *
 * The directory name was hardcoded at thirteen call sites across the agent
 * factory, the state layer, the tools, the observability layer and the CLI —
 * each with its own `path.join(rootDir, '.agent')`. That is the same shape this
 * repository has now been bitten by four times: **one fact assembled in many
 * places and verified in one**, recorded in `docs/deferred-work.md` for the tool
 * registry and in ADR-017 for the harness profile and the project id.
 *
 * Renaming was the occasion; the single constant is the actual fix, and it would
 * have been worth doing even if the name had stayed.
 *
 * ## Why the name changed
 *
 * `.agent/` is generic, and the ecosystem convention is vendor-named:
 * `.claude/`, `.codex/`, `.gemini/`, `.cursor/`. What is shared across tools is
 * the `AGENTS.md` *file*, not an `.agent/` *directory*. On a machine running
 * several agents side by side — which is the normal case here — "whose `.agent/`
 * is this?" has no answer. `.umbra/` matches the package and the binary and
 * admits no ambiguity.
 *
 * @example
 * ```ts
 * agentPath(rootDir);                          // <root>/.umbra
 * agentPath(rootDir, 'backups');               // <root>/.umbra/backups
 * agentPath(rootDir, 'telemetry', 'turns.jsonl');
 * ```
 */

import * as fs from 'fs';
import * as path from 'path';

/** Directory holding Umbra's per-project workspace state. */
export const AGENT_DIR_NAME = '.umbra';

/**
 * The directory this workspace used before `.umbra/`.
 *
 * Kept so an existing project is migrated rather than silently abandoned: the
 * RAG index, the session history, the backups and the local policy all lived
 * here, and a rename without a move is data loss dressed up as a rename.
 */
export const LEGACY_AGENT_DIR_NAME = '.agent';

/**
 * Builds a path inside the project's Umbra workspace.
 *
 * @param rootDir - Project root.
 * @param segments - Path segments below the workspace directory.
 * @returns The absolute path.
 */
export function agentPath(rootDir: string, ...segments: string[]): string {
  return path.join(rootDir, AGENT_DIR_NAME, ...segments);
}

/** Outcome of a legacy-workspace migration attempt. */
export interface AgentDirectoryMigration {
  /** Whether a legacy directory was moved by this call. */
  migrated: boolean;
  /** Why nothing was moved, when `migrated` is false. */
  reason?: 'no-legacy-directory' | 'both-exist' | 'move-failed';
}

/**
 * Moves a pre-existing `.agent/` workspace to `.umbra/`.
 *
 * Idempotent and safe to call on every start: with no legacy directory, or with
 * both present, nothing is touched. The both-present case is deliberately left
 * alone rather than merged — two workspaces mean two session histories, and
 * picking one for the operator could discard work.
 *
 * A failed move is reported, never thrown. Umbra recreates whatever is missing;
 * refusing to start because an old directory could not be renamed would be a
 * worse outcome than reindexing.
 *
 * @param rootDir - Project root to migrate.
 * @returns What happened, so the caller can tell the operator.
 */
export function migrateLegacyAgentDirectory(rootDir: string): AgentDirectoryMigration {
  const legacyDir = path.join(rootDir, LEGACY_AGENT_DIR_NAME);
  const currentDir = path.join(rootDir, AGENT_DIR_NAME);

  try {
    if (!fs.existsSync(legacyDir)) return { migrated: false, reason: 'no-legacy-directory' };
    if (fs.existsSync(currentDir)) return { migrated: false, reason: 'both-exist' };

    fs.renameSync(legacyDir, currentDir);
    return { migrated: true };
  } catch {
    return { migrated: false, reason: 'move-failed' };
  }
}
