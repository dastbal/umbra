import * as path from 'path';

/**
 * The one place that answers "which repository is this process working on?".
 *
 * ## Why this exists
 *
 * Under the CLI, `process.cwd()` is the right answer and always was: the
 * operator runs `umbra` from inside the project. Under `umbra mcp` it is the
 * wrong answer, because the process is spawned by a client whose working
 * directory has nothing to do with the repository being served.
 *
 * ADR-024 constraint 3 goes further and forbids the obvious shortcut: the root
 * must **never** be read from a tool argument. Accepting one would reopen the
 * path-traversal surface ADR-011 closed and hand it to a remote caller. So the
 * root is pinned once, at launch, from a source the caller of the *process*
 * controls, and every consumer reads it from here.
 *
 * This is ADR-018's lesson applied to a second value: one fact, one constant,
 * instead of the same `process.cwd()` call repeated at every boundary.
 *
 * @example
 * ```ts
 * pinRuntimeRoot('/home/david/projects/londonuw-payments');
 * const root = runtimeRoot();
 * ```
 */

let pinnedRoot: string | undefined;

/**
 * Fixes the project root for the lifetime of the process.
 *
 * Re-pinning the same directory is a no-op, so a startup path that runs twice
 * is harmless. Re-pinning a *different* directory throws: it means two parts of
 * the process disagree about which repository is being served, and continuing
 * would silently serve one of them. `AgentDB` caches its connection on first
 * use, so by the time a second root arrives some rows may already have been
 * read from the first — a loud failure is the only honest outcome.
 *
 * @param dir - Absolute or relative directory; stored resolved.
 * @throws {Error} When a different root was already pinned.
 */
export function pinRuntimeRoot(dir: string): void {
  const resolved = path.resolve(dir);

  if (pinnedRoot !== undefined && pinnedRoot !== resolved) {
    throw new Error(
      `Runtime root already pinned to "${pinnedRoot}"; refusing to re-pin to "${resolved}". ` +
        'The project root is fixed once at launch (ADR-024, constraint 3).',
    );
  }

  pinnedRoot = resolved;
}

/**
 * Returns the project root every subsystem should resolve paths against.
 *
 * Falls back to `process.cwd()` when nothing was pinned, which preserves the
 * existing behaviour of every CLI command exactly.
 *
 * @returns The pinned root, or the current working directory.
 */
export function runtimeRoot(): string {
  return pinnedRoot ?? process.cwd();
}

/**
 * Clears the pinned root.
 *
 * Exists for tests, which must not leak a root into the next spec. Not part of
 * the runtime contract — production code pins once and never unpins.
 */
export function resetRuntimeRoot(): void {
  pinnedRoot = undefined;
}
