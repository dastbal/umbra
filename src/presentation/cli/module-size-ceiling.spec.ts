import fs from 'node:fs';
import path from 'node:path';

/**
 * Files whose growth is capped, with the ceiling they may not exceed.
 *
 * The ceiling is the file's size on the day the cap was introduced, so the
 * rule is purely a ratchet: existing size is grandfathered, new size is not.
 * This deliberately does **not** demand a refactor. `ChatSession` reached
 * 1,418 lines while the domain and RAG layers stayed small, which is the
 * ordinary shape of a personal project — the interesting layer gets care and
 * the layer that merely has to work accumulates. Splitting it today would be a
 * large, risky, untestable change competing with measurement work that matters
 * more. Stopping the growth costs nothing and is what actually prevents the
 * problem from getting worse while that work happens.
 *
 * When a file genuinely shrinks, lower its ceiling in the same commit. The
 * `SLACK` assertion below fails until you do, so the ratchet tightens instead
 * of quietly leaving room to grow back.
 */
const CEILINGS: ReadonlyArray<{ readonly file: string; readonly maxLines: number }> = [
  // The presentation-layer offender. Every new CLI concern goes into its own
  // module under `src/presentation/cli/` instead of here.
  //
  // Lowered from 1,418 when rendering a suspension moved to `hitl-prompt.ts`:
  // answering every pending interrupt instead of only the first would otherwise
  // have spent the ratchet's slack on the file it exists to hold down.
  //
  // Lowered again, from 1,355, when `checkAndCompressContext` was removed:
  // context editing clears stale tool results inside the model call (ADR-037),
  // so the turn no longer ends with a summary appended to its own thread.
  { file: 'src/presentation/cli/chat-session.ts', maxLines: 1292 },
];

/** How far below its ceiling a file may sit before the ceiling must be lowered. */
const SLACK = 50;

const repoRoot = path.resolve(__dirname, '..', '..', '..');

/**
 * Counts lines the way `wc -l` does, so a ceiling can be checked against the
 * number a developer sees in their editor. A trailing newline would otherwise
 * add a phantom line and put every file one over its real size.
 */
function lineCountOf(relativePath: string): number {
  const absolute = path.join(repoRoot, relativePath);
  const text = fs.readFileSync(absolute, 'utf8');
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines.length;
}

describe('module size ceilings', () => {
  it.each(CEILINGS)('$file stays at or below $maxLines lines', ({ file, maxLines }) => {
    const lines = lineCountOf(file);

    if (lines > maxLines) {
      throw new Error(
        `${file} grew to ${lines} lines, above its ${maxLines}-line ceiling. ` +
          `Put the new behaviour in its own module rather than raising the ceiling.`,
      );
    }
  });

  it.each(CEILINGS)('$file has a ceiling that still tracks its real size', ({ file, maxLines }) => {
    const lines = lineCountOf(file);

    if (lines <= maxLines - SLACK) {
      throw new Error(
        `${file} is down to ${lines} lines but its ceiling is still ${maxLines}. ` +
          `Lower the ceiling in this commit so the reduction cannot be spent again.`,
      );
    }
  });
});
