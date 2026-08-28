import * as fs from 'fs';
import * as path from 'path';

/** Categories of side effects that an agent tool can request. */
export type AgentActionKind =
  | 'read_file'
  | 'write_file'
  | 'delete_file'
  | 'run_test'
  | 'run_type_check'
  | 'run_lint'
  | 'execute_command'
  | 'git_mutation'
  | 'network';

/** Decision returned before any side effect is performed. */
export type PolicyDecision = 'allow' | 'require_approval' | 'deny';

/** A normalized agent-side action awaiting authorization. */
export interface ActionRequest {
  kind: AgentActionKind;
  rootDir: string;
  targetPath?: string;
  command?: string;
}

/** Result of an authorization evaluation, safe to show to a user. */
export interface PolicyEvaluation {
  decision: PolicyDecision;
  reason: string;
}

const protectedFileNames = new Set([
  '.git',
  '.env',
  '.npmrc',
  '.yarnrc',
  '.pypirc',
  'id_rsa',
  'id_ed25519',
]);

const approvalDirectories = new Set(['.github', 'infra', 'infrastructure', 'deploy', 'deployment']);
const approvedWriteRoots = new Set(['src', 'test', 'tests', 'docs']);

/**
 * Central, deterministic authorization policy for every runtime tool.
 *
 * The policy is intentionally restrictive: configuration cannot weaken a
 * universal deny for credentials, repository metadata, path escapes, or shell
 * execution. Callers may provide a human approval flow for the explicit
 * `require_approval` result.
 */
export class AgentSecurityPolicy {
  /** Evaluates a tool request without performing the requested action. */
  public evaluate(request: ActionRequest): PolicyEvaluation {
    if (request.kind === 'execute_command' || request.kind === 'network' || request.kind === 'git_mutation') {
      return { decision: 'require_approval', reason: 'External or arbitrary execution requires explicit approval.' };
    }

    if (request.kind === 'run_test' || request.kind === 'run_type_check' || request.kind === 'run_lint') {
      return { decision: 'allow', reason: 'The command is a fixed local verification action.' };
    }

    if (!request.targetPath) {
      return { decision: 'deny', reason: 'A filesystem action requires a target path.' };
    }

    const target = resolveWorkspacePath(request.rootDir, request.targetPath);
    if (target === undefined) {
      return { decision: 'deny', reason: 'The target escapes the workspace or resolves through a symlink.' };
    }

    const workspaceRoot = resolveExistingPath(path.resolve(request.rootDir));
    if (workspaceRoot === undefined) {
      return { decision: 'deny', reason: 'The workspace root cannot be resolved safely.' };
    }
    // Segments come from the REAL path returned above, never from the requested
    // one: otherwise a link named `notes.txt` pointing at `.env` would clear the
    // protected-name check on its own harmless name.
    const relative = path.relative(workspaceRoot, target);
    const segments = relative.split(path.sep).filter(Boolean);
    if (segments.some((segment) => isProtectedSegment(segment))) {
      return { decision: 'deny', reason: 'Credentials and repository metadata are never accessible to agent tools.' };
    }

    if (request.kind === 'delete_file') {
      return { decision: 'require_approval', reason: 'Deleting a file requires explicit approval.' };
    }

    if (request.kind === 'read_file') {
      return { decision: 'allow', reason: 'The target is a non-sensitive workspace file.' };
    }

    if (segments.length === 0) {
      return { decision: 'require_approval', reason: 'Writing the workspace root requires explicit approval.' };
    }

    if (approvalDirectories.has(segments[0]) || isConfigurationFile(segments)) {
      return { decision: 'require_approval', reason: 'Configuration, CI, and deployment changes require explicit approval.' };
    }

    return approvedWriteRoots.has(segments[0])
      ? { decision: 'allow', reason: 'The target is an approved source, test, or documentation path.' }
      : { decision: 'require_approval', reason: 'Writing outside approved code paths requires explicit approval.' };
  }
}

/**
 * Resolves an untrusted relative path only when it remains inside the real workspace.
 *
 * The returned value is the *real* path, not the requested one: callers must
 * perform their side effect on the location the policy actually inspected, or a
 * link in the requested path would send the write somewhere else.
 *
 * @param rootDir - The workspace root that bounds every agent action.
 * @param targetPath - The untrusted path requested by a tool.
 * @returns The real, contained path, or `undefined` when it escapes.
 */
export function resolveWorkspacePath(rootDir: string, targetPath: string): string | undefined {
  const resolvedRoot = resolveExistingPath(path.resolve(rootDir));
  if (resolvedRoot === undefined) return undefined;
  const candidate = path.resolve(resolvedRoot, targetPath);
  if (!isInsideRoot(resolvedRoot, candidate)) return undefined;

  const existingParent = nearestExistingParent(candidate);
  if (existingParent === undefined) return undefined;
  const realParent = resolveExistingPath(existingParent);
  if (realParent === undefined) return undefined;
  if (!isInsideRoot(resolvedRoot, realParent)) return undefined;

  // The parent check cannot see a link in the FINAL component: when the candidate
  // exists and resolves to a file, `nearestExistingParent` returns the containing
  // directory, so `src/notes.txt -> ../../.env` keeps a legitimate parent while
  // the read follows the link out of the workspace. Resolve the candidate itself.
  if (!pathExistsWithoutFollowing(candidate)) return candidate;
  const realCandidate = resolveExistingPath(candidate);
  if (realCandidate === undefined) return undefined;
  return isInsideRoot(resolvedRoot, realCandidate) ? realCandidate : undefined;
}

/** Reports whether a resolved path stays inside the workspace root. */
function isInsideRoot(resolvedRoot: string, candidate: string): boolean {
  const relative = path.relative(resolvedRoot, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * Reports whether a path exists without following a final symlink.
 *
 * `fs.existsSync` follows links, so a dangling link reads as "absent" and would
 * be treated as a file to create — writing through it lands outside the
 * workspace. `lstat` sees the link itself.
 */
function pathExistsWithoutFollowing(candidate: string): boolean {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch {
    return false;
  }
}

/** Returns the nearest existing directory for a prospective filesystem target. */
function nearestExistingParent(candidate: string): string | undefined {
  let current = candidate;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return fs.statSync(current).isDirectory() ? current : path.dirname(current);
}

/** Resolves a real existing path without leaking filesystem errors to callers. */
function resolveExistingPath(candidate: string): string | undefined {
  try {
    const nativeRealpath = fs.realpathSync.native;
    const nativeResolved = typeof nativeRealpath === 'function'
      ? nativeRealpath(candidate)
      : undefined;
    const resolved = typeof nativeResolved === 'string'
      ? nativeResolved
      : fs.realpathSync(candidate);
    return typeof resolved === 'string' ? resolved : undefined;
  } catch {
    return undefined;
  }
}

/** Identifies a sensitive workspace segment. */
function isProtectedSegment(segment: string): boolean {
  const normalized = segment.toLowerCase();
  return protectedFileNames.has(normalized) || normalized.startsWith('.env') || normalized.includes('credential') || normalized.includes('secret');
}

/** Identifies root-level project configuration and lock files. */
function isConfigurationFile(segments: string[]): boolean {
  const file = segments[segments.length - 1].toLowerCase();
  return segments.length === 1 && (
    file === 'package.json' ||
    file.endsWith('lock.json') ||
    file === 'pnpm-lock.yaml' ||
    file === 'yarn.lock' ||
    file.startsWith('dockerfile') ||
    file.startsWith('cloudbuild')
  );
}
