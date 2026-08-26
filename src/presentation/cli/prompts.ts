/**
 * @module Prompts
 *
 * The one place to look when something needs to ask the operator a question.
 *
 * Four primitives cover essentially every terminal interaction:
 *
 * | Need | Use |
 * |---|---|
 * | Pick one of a list | {@link select} |
 * | Pick several of a list | {@link multiSelect} |
 * | Yes or no | {@link confirm} |
 * | Free text | {@link askText} |
 *
 * ## Why a facade
 *
 * `select` and `multiSelect` live in `./interactive-select`, which is the
 * arrow-key engine and nothing else. Text input is a different mechanism
 * entirely — it uses `readline` in its normal line-buffered mode, not raw mode —
 * so putting it in that module would mix two unrelated things.
 *
 * This module is what callers import. It means whoever adds the next
 * interaction does not have to know which mechanism their question needs, or
 * remember where each one lives. That is the difference between an engine that
 * gets reused and one that gets re-implemented next to itself.
 *
 * ## Every primitive degrades
 *
 * `select`, `multiSelect` and `confirm` need a TTY; without one they fall back
 * or report `unavailable`. `askText` works either way, because line-buffered
 * `readline` reads a pipe perfectly well. A caller that uses only `askText`
 * needs no branch at all.
 *
 * ## The readline lifetime rule
 *
 * `askText` creates a readline interface, reads one line, and closes it
 * **before** resolving. A readline left open while the agent streams prints
 * phantom `>` prompts into the output; see `ChatSession`. Never hold one open
 * across anything else, and never have one open while an arrow prompt is up —
 * two readers split the keystrokes between them.
 *
 * @example
 * ```ts
 * import { select, confirm, askText } from './prompts';
 *
 * const branch = await select({
 *   title: 'Which branch?',
 *   choices: [{ label: 'main', value: 'main', active: true }],
 * });
 *
 * if (await confirm({ question: 'Push it?', defaultValue: false })) {
 *   const message = await askText({ prompt: '  Commit message: ' });
 * }
 * ```
 */

import * as readline from 'readline';
import { colors } from './theme';
import { isInteractive, selectOutcome } from './interactive-select';

export {
  select,
  multiSelect,
  selectOutcome,
  isInteractive,
  type SelectChoice,
  type SelectOptions,
  type MultiSelectOptions,
  type SelectOutcome,
} from './interactive-select';

// ── Free text ────────────────────────────────────────────────────────────────

/**
 * Configuration for {@link askText}.
 */
export interface AskTextOptions {
  /** The prompt to display. Style it with `colors` before passing it in. */
  prompt: string;
  /**
   * Called if the operator presses Ctrl+C while the question is open.
   *
   * Without a handler, Ctrl+C resolves the question as `null` and leaves the
   * decision to the caller. Pass one when the interruption should end the
   * session rather than the question.
   */
  onInterrupt?: () => void;
  /** Input stream. Overridable for tests. @default process.stdin */
  input?: NodeJS.ReadStream;
  /** Output stream. Overridable for tests. @default process.stdout */
  output?: NodeJS.WriteStream;
}

/**
 * Asks for a line of free text.
 *
 * Works with or without a TTY: line-buffered `readline` reads a pipe as
 * happily as a keyboard, which is why this is the only primitive here that
 * never needs a fallback.
 *
 * @param opts - Prompt configuration.
 * @returns The raw answer, or `null` if the operator interrupted. Not trimmed —
 *          leading space can be meaningful in a commit message or a prompt.
 */
export function askText(opts: AskTextOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: opts.input ?? process.stdin,
      output: opts.output ?? process.stdout,
    });

    rl.on('SIGINT', () => {
      rl.close();
      opts.onInterrupt?.();
      resolve(null);
    });

    rl.question(opts.prompt, (answer) => {
      // Closed before resolving, so nothing downstream runs with a live
      // readline attached to stdin.
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * Asks for a whole number inside a range, re-reading nothing on a bad answer.
 *
 * A single attempt by design: this is the fallback used when there is no TTY,
 * which usually means a pipe, and re-prompting a pipe that has no more input
 * loops without progress. An invalid answer resolves `null` and the caller
 * treats it as a cancellation.
 *
 * @param prompt - The prompt to display, already styled.
 * @param min - Lowest acceptable value, inclusive.
 * @param max - Highest acceptable value, inclusive.
 * @param opts - Stream overrides for tests.
 * @returns The parsed number, or `null` when the answer was empty or invalid.
 */
export async function askNumber(
  prompt: string,
  min: number,
  max: number,
  opts: Pick<AskTextOptions, 'input' | 'output'> = {},
): Promise<number | null> {
  const answer = await askText({ prompt, ...opts });
  if (answer === null) return null;

  const trimmed = answer.trim();
  if (!trimmed) return null;

  const parsed = Number.parseInt(trimmed, 10);
  if (Number.isNaN(parsed) || parsed < min || parsed > max) {
    console.log(
      colors.warning(`  Invalid choice. Please enter a number between ${min} and ${max}.`),
    );
    return null;
  }

  return parsed;
}

// ── Yes / no ─────────────────────────────────────────────────────────────────

/**
 * Configuration for {@link confirm}.
 */
export interface ConfirmOptions {
  /** The question, without a trailing `[y/n]` — the prompt adds its own hints. */
  question: string;
  /**
   * Which option the cursor opens on, and what a bare Enter means in the typed
   * fallback.
   *
   * Choose this deliberately: for anything destructive it should be `false`, so
   * the fast, unthinking answer is the safe one.
   *
   * @default false
   */
  defaultValue?: boolean;
  /** Label for the affirmative row. @default 'Yes' */
  yesLabel?: string;
  /** Label for the negative row. @default 'No' */
  noLabel?: string;
  /** Input stream. Overridable for tests. @default process.stdin */
  input?: NodeJS.ReadStream;
  /** Output stream. Overridable for tests. @default process.stdout */
  output?: NodeJS.WriteStream;
}

/**
 * Asks a yes/no question.
 *
 * Arrow-navigable when there is a TTY, `[y/N]` typed otherwise.
 *
 * @param opts - Prompt configuration.
 * @returns `true` or `false`, or `null` when the operator cancelled or
 *          interrupted. **Do not coerce `null` to `false` without thinking** —
 *          at a security boundary they mean the same thing, but for a question
 *          like "keep this session?" they do not.
 */
export async function confirm(opts: ConfirmOptions): Promise<boolean | null> {
  const yesLabel = opts.yesLabel ?? 'Yes';
  const noLabel  = opts.noLabel  ?? 'No';
  const fallbackDefault = opts.defaultValue ?? false;

  if (!isInteractive(opts.input ?? process.stdin, opts.output ?? process.stdout)) {
    const hint = fallbackDefault ? '[Y/n]' : '[y/N]';
    const answer = await askText({
      prompt: colors.warning(`  ${opts.question} ${hint} `),
      input: opts.input,
      output: opts.output,
    });
    if (answer === null) return null;

    const normalized = answer.trim().toLowerCase();
    if (!normalized) return fallbackDefault;
    return normalized === 'y' || normalized === 'yes';
  }

  const outcome = await selectOutcome<boolean>({
    title: opts.question,
    choices: [
      { label: yesLabel, value: true,  active: fallbackDefault === true },
      { label: noLabel,  value: false, active: fallbackDefault === false },
    ],
    input: opts.input,
    output: opts.output,
  });

  return outcome.status === 'selected' ? outcome.value : null;
}
