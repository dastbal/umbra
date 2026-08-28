/**
 * @module InteractiveSelect
 *
 * Arrow-key navigable selection prompts for the Umbra CLI.
 *
 * Renders a list in place, moves a highlight with the arrow keys, and resolves
 * when the user presses Enter. This is the interaction model used by
 * `create-next-app` and the Claude CLI, implemented here with Node built-ins
 * instead of a prompt library.
 *
 * ## How it works
 *
 * Four mechanisms, none of which require a dependency:
 *
 * 1. **TTY detection** — an arrow menu is only possible on an interactive
 *    terminal. Piped or redirected input has no keystrokes to read, so callers
 *    must check {@link isInteractive} and fall back to a typed prompt.
 * 2. **Raw mode** — `setRawMode(true)` disables the terminal's line buffer, so
 *    each keystroke arrives immediately and is not echoed. Without it an arrow
 *    key never reaches the process; it sits in the line buffer until Enter.
 * 3. **Keypress decoding** — arrows arrive as multi-byte escape sequences
 *    (`ESC [ A` for up). `readline.emitKeypressEvents` parses them into named
 *    `keypress` events, so this module never parses bytes by hand.
 * 4. **In-place repaint** — after each keystroke the previously drawn block is
 *    erased by moving the cursor up N lines and clearing to the end of the
 *    screen, then redrawn. This is the same technique `ora` uses for its
 *    spinner. The alternate screen buffer is deliberately *not* used: it would
 *    erase the menu from the scrollback once the prompt closes.
 *
 * ## Ownership of stdin
 *
 * While a prompt is open it is the **only** consumer of stdin. A `readline`
 * interface must never be alive at the same time, or the two compete for the
 * same stream and keystrokes are split arbitrarily between them. `ChatSession`
 * satisfies this: its short-lived readline is closed before the slash-command
 * dispatcher runs.
 *
 * ## Terminal restoration
 *
 * Raw mode is a global change to the user's terminal. If the process leaves it
 * enabled, the terminal stops echoing typed characters and appears broken. Every
 * exit path — resolve, cancel, or thrown error — restores it through a teardown
 * step, and a process-level `exit` handler acts as a last resort.
 *
 * @example
 * ```ts
 * if (!isInteractive()) return askNumberFallback();
 *
 * const outcome = await selectOutcome({
 *   title: 'Select Provider',
 *   choices: [
 *     { label: 'Vertex AI', value: 'vertex', active: true },
 *     { label: 'Ollama',    value: 'ollama' },
 *   ],
 * });
 *
 * if (outcome.status === 'selected') use(outcome.value);
 * ```
 */

import * as readline from 'readline';
import chalk from 'chalk';
import { colors } from './theme';

// ── ANSI control sequences ───────────────────────────────────────────────────

const ESC = '\x1b';
/** Hides the terminal cursor, so it does not flicker across the redrawn menu. */
const CURSOR_HIDE = `${ESC}[?25l`;
/** Restores the terminal cursor. */
const CURSOR_SHOW = `${ESC}[?25h`;
/** Erases from the cursor to the end of the screen. */
const CLEAR_DOWN = `${ESC}[0J`;

/**
 * Builds the escape sequence that moves the cursor up `n` rows.
 *
 * @param n - Number of rows to move up. Zero yields an empty string.
 * @returns The escape sequence, or an empty string when there is nothing to move.
 */
function cursorUp(n: number): string {
  return n > 0 ? `${ESC}[${n}A` : '';
}

// ── Public types ─────────────────────────────────────────────────────────────

/**
 * A single row of a selection prompt.
 *
 * @typeParam T - The value produced when this row is chosen.
 */
export interface SelectChoice<T> {
  /** Text shown to the user. Separators use this as their heading. */
  label: string;
  /** Value resolved when this row is chosen. Ignored for separators. */
  value?: T;
  /** Optional dimmed text shown after the label (a size, a description). */
  hint?: string;
  /** Marks the row as the currently active setting, tagged with an active marker. */
  active?: boolean;
  /** Renders as a non-selectable heading. Arrow navigation skips it. */
  separator?: boolean;
  /** Renders dimmed and cannot be chosen. Arrow navigation skips it. */
  disabled?: boolean;
}

/**
 * Configuration for {@link select} and {@link selectOutcome}.
 *
 * @typeParam T - The value type carried by the choices.
 */
export interface SelectOptions<T> {
  /** Heading printed above the list. */
  title?: string;
  /** Rows to display. Must contain at least one selectable row. */
  choices: SelectChoice<T>[];
  /** Maximum rows shown at once before the list scrolls. @default 12 */
  pageSize?: number;
  /** Index highlighted on open. Defaults to the `active` row, else the first. */
  initialIndex?: number;
  /** Input stream. Overridable for tests. @default process.stdin */
  input?: NodeJS.ReadStream;
  /** Output stream. Overridable for tests. @default process.stdout */
  output?: NodeJS.WriteStream;
}

/**
 * Configuration for {@link multiSelect}, which adds toggling to {@link SelectOptions}.
 *
 * @typeParam T - The value type carried by the choices.
 */
export interface MultiSelectOptions<T> extends SelectOptions<T> {
  /** Indices checked when the prompt opens. @default [] */
  initialSelected?: number[];
}

/**
 * The result of a selection prompt.
 *
 * Four outcomes rather than a nullable value, because the caller has to act
 * differently on each: `unavailable` means fall back to a typed prompt, while
 * `interrupted` means the user asked to terminate the session.
 *
 * @typeParam T - The selected value type.
 */
export type SelectOutcome<T> =
  /** The user confirmed a row with Enter. */
  | { status: 'selected'; value: T; index: number }
  /** The user pressed Escape or `q`. */
  | { status: 'cancelled' }
  /** The user pressed Ctrl+C. The caller decides whether to shut down. */
  | { status: 'interrupted' }
  /** No interactive terminal is attached. Nothing was drawn. */
  | { status: 'unavailable' };

// ── Terminal restoration safety net ──────────────────────────────────────────

/** Teardown callbacks for prompts that are currently open. */
const activeTeardowns = new Set<() => void>();
/** Whether the process-level `exit` restore handler has been installed. */
let exitHandlerInstalled = false;

/**
 * Installs a process-level handler that restores the terminal if the process
 * exits while a prompt is open.
 *
 * Without this a crash mid-prompt leaves raw mode enabled and the cursor
 * hidden, which makes the user's shell appear dead: typed characters produce
 * no echo. Installed once, lazily.
 */
function ensureExitHandler(): void {
  if (exitHandlerInstalled) return;
  exitHandlerInstalled = true;
  process.on('exit', () => {
    for (const teardown of activeTeardowns) {
      try { teardown(); } catch { /* nothing useful to do while exiting */ }
    }
    activeTeardowns.clear();
  });
}

// ── Capability detection ─────────────────────────────────────────────────────

/**
 * Reports whether an arrow-key prompt can run on the given streams.
 *
 * Callers **must** check this before opening a prompt and fall back to a typed
 * prompt when it returns false. Without a TTY there are no keystrokes to read
 * and the prompt would wait forever — the failure mode is a hang, not an error.
 *
 * @param input - Input stream to test. @default process.stdin
 * @param output - Output stream to test. @default process.stdout
 * @returns True when both streams are TTYs and raw mode is available.
 */
export function isInteractive(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): boolean {
  return Boolean(input?.isTTY) &&
         Boolean(output?.isTTY) &&
         typeof input.setRawMode === 'function';
}

// ── Rendering helpers ────────────────────────────────────────────────────────

/**
 * Truncates plain text to a maximum display width.
 *
 * Applied to the raw label *before* colouring, because ANSI escape codes have
 * no display width and would corrupt any length arithmetic done after styling.
 *
 * @param text - Uncoloured text.
 * @param max - Maximum display width.
 * @returns The text, shortened with an ellipsis when it exceeds `max`.
 */
function fit(text: string, max: number): string {
  if (max <= 1) return '';
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

/**
 * Determines whether a row can be chosen.
 *
 * @param choice - The row to test.
 * @returns True when the row is neither a separator nor disabled.
 */
function isSelectable<T>(choice: SelectChoice<T>): boolean {
  return !choice.separator && !choice.disabled;
}

/**
 * Finds the next selectable row in a direction, wrapping around the ends.
 *
 * Separators and disabled rows are skipped so the highlight never rests on a
 * row that Enter cannot confirm.
 *
 * @param choices - All rows.
 * @param from - Current index.
 * @param step - `1` to move down, `-1` to move up.
 * @returns The next selectable index, or `from` when none exists.
 */
function nextSelectable<T>(choices: SelectChoice<T>[], from: number, step: number): number {
  const total = choices.length;
  for (let offset = 1; offset <= total; offset++) {
    const candidate = ((from + step * offset) % total + total) % total;
    if (isSelectable(choices[candidate])) return candidate;
  }
  return from;
}

/**
 * Computes the first visible row so the cursor stays inside the viewport.
 *
 * @param cursor - Index of the highlighted row.
 * @param total - Total number of rows.
 * @param pageSize - Number of rows that fit on screen.
 * @returns The index of the first row to draw.
 */
function windowStart(cursor: number, total: number, pageSize: number): number {
  if (total <= pageSize) return 0;
  const half = Math.floor(pageSize / 2);
  return Math.min(Math.max(0, cursor - half), total - pageSize);
}

/**
 * Resolves the row the cursor starts on.
 *
 * Prefers an explicit index, then the row flagged `active`, then the first
 * selectable row — so opening `/model` lands on the model already in use.
 *
 * @param choices - All rows.
 * @param requested - Explicitly requested index, if any.
 * @returns A selectable index.
 */
function resolveInitialIndex<T>(choices: SelectChoice<T>[], requested?: number): number {
  if (requested !== undefined && choices[requested] && isSelectable(choices[requested])) {
    return requested;
  }
  const activeIdx = choices.findIndex((c) => c.active && isSelectable(c));
  if (activeIdx !== -1) return activeIdx;
  return choices.findIndex(isSelectable);
}

/**
 * Finds the Nth selectable row, counting from one.
 *
 * @param choices - All rows.
 * @param n - One-based position among selectable rows.
 * @returns The index, or `-1` when there is no such row.
 */
function nthSelectable<T>(choices: SelectChoice<T>[], n: number): number {
  let seen = 0;
  for (let i = 0; i < choices.length; i++) {
    if (!isSelectable(choices[i])) continue;
    if (++seen === n) return i;
  }
  return -1;
}

// ── The shared prompt engine ─────────────────────────────────────────────────

/**
 * Mutable state shared by the single- and multi-select renderers.
 */
interface RenderState {
  /** Index of the highlighted row. */
  cursor: number;
  /** Indices checked in multi-select mode. */
  checked: Set<number>;
}

/**
 * Runs an interactive prompt loop until the user resolves it.
 *
 * Owns stdin for its lifetime, repaints on every keystroke, and restores the
 * terminal on every exit path.
 *
 * @typeParam T - The value type carried by the choices.
 * @param opts - Prompt configuration.
 * @param multi - True to enable Space-to-toggle multi-selection.
 * @returns The outcome, plus the checked indices when `multi` is true.
 */
async function runPrompt<T>(
  opts: MultiSelectOptions<T>,
  multi: boolean,
): Promise<{ outcome: SelectOutcome<T>; checked: number[] }> {
  const input   = opts.input  ?? process.stdin;
  const output  = opts.output ?? process.stdout;
  const choices = opts.choices;

  if (!isInteractive(input, output) || !choices.some(isSelectable)) {
    return { outcome: { status: 'unavailable' }, checked: [] };
  }

  const pageSize = Math.max(3, opts.pageSize ?? 12);
  const width    = Math.max(20, (output.columns ?? 80) - 2);

  const state: RenderState = {
    cursor: resolveInitialIndex(choices, opts.initialIndex),
    checked: new Set(opts.initialSelected ?? []),
  };

  /** Number of rows drawn by the previous paint, needed to erase them. */
  let drawnLines = 0;

  /**
   * Builds every line of the prompt for the current state.
   *
   * @returns The lines to print, already styled and width-fitted.
   */
  const buildLines = (): string[] => {
    const lines: string[] = [];

    if (opts.title) {
      lines.push(colors.secondary.bold(`  ${fit(opts.title, width - 2)}`));
    }

    const start = windowStart(state.cursor, choices.length, pageSize);
    const end   = Math.min(choices.length, start + pageSize);

    if (start > 0) lines.push(colors.dim('    ↑ …'));

    for (let i = start; i < end; i++) {
      const choice = choices[i];

      if (choice.separator) {
        lines.push(colors.secondary(`    ${fit(choice.label, width - 4)}`));
        continue;
      }

      const isCursor = i === state.cursor;
      const pointer  = isCursor ? colors.primary.bold('❯') : ' ';
      const checkbox = multi
        ? (state.checked.has(i) ? colors.accent('◉') : colors.dim('◯')) + ' '
        : '';

      // Reserve room for the pointer, checkbox, hint and active tag.
      const budget = width - 6 - (multi ? 2 : 0) -
                     (choice.hint ? choice.hint.length + 4 : 0) -
                     (choice.active ? 9 : 0);
      const label = fit(choice.label, Math.max(8, budget));

      const styled = choice.disabled
        ? colors.dim(label)
        : isCursor
          ? colors.primary.bold(label)
          : chalk.white(label);

      const hint      = choice.hint   ? colors.muted(`  (${choice.hint})`) : '';
      const activeTag = choice.active ? colors.accent(' ← active')         : '';

      lines.push(`  ${pointer} ${checkbox}${styled}${hint}${activeTag}`);
    }

    if (end < choices.length) lines.push(colors.dim('    ↓ …'));

    // `q` is advertised alongside Escape rather than hidden as a synonym: a
    // lone ESC byte is ambiguous to the keypress decoder, which emits nothing
    // until another byte arrives, so Escape can appear not to respond to the
    // first press. `q` is one unambiguous byte and always lands.
    lines.push(
      colors.muted(
        multi
          ? '    ↑↓ move · space toggle · enter confirm · esc/q cancel'
          : '    ↑↓ move · enter select · esc/q cancel',
      ),
    );

    return lines;
  };

  /** Erases the previous paint and draws the current state. */
  const paint = (): void => {
    if (drawnLines > 0) output.write(cursorUp(drawnLines) + CLEAR_DOWN);
    const lines = buildLines();
    output.write(lines.join('\n') + '\n');
    drawnLines = lines.length;
  };

  /** Erases the prompt entirely, leaving the cursor where the prompt started. */
  const erase = (): void => {
    if (drawnLines > 0) {
      output.write(cursorUp(drawnLines) + CLEAR_DOWN);
      drawnLines = 0;
    }
  };

  return new Promise<{ outcome: SelectOutcome<T>; checked: number[] }>((resolve) => {
    ensureExitHandler();

    const wasRaw = Boolean(input.isRaw);

    /**
     * Restores the terminal and detaches every listener.
     *
     * Idempotent: it runs from the resolve path and may run again from the
     * process `exit` handler.
     */
    const teardown = (): void => {
      input.removeListener('keypress', onKeypress);
      try {
        if (typeof input.setRawMode === 'function') input.setRawMode(wasRaw);
      } catch { /* the stream may already be closed */ }
      input.pause();
      output.write(CURSOR_SHOW);
      activeTeardowns.delete(teardown);
    };

    /**
     * Closes the prompt with a given outcome.
     *
     * @param outcome - The outcome to resolve with.
     */
    const finish = (outcome: SelectOutcome<T>): void => {
      erase();
      teardown();
      resolve({ outcome, checked: [...state.checked].sort((a, b) => a - b) });
    };

    /**
     * Handles one decoded keystroke.
     *
     * @param _str - The raw string for the key. Unused; `key` carries the name.
     * @param key - The decoded key descriptor produced by readline.
     */
    function onKeypress(_str: string, key: readline.Key | undefined): void {
      if (!key) return;

      // Raw mode suppresses SIGINT, so Ctrl+C must be handled explicitly or the
      // user has no way out of the prompt.
      if (key.ctrl && key.name === 'c') { finish({ status: 'interrupted' }); return; }
      if (key.ctrl) return;

      switch (key.name) {
        case 'up':
        case 'k':
          state.cursor = nextSelectable(choices, state.cursor, -1);
          paint();
          return;

        case 'down':
        case 'j':
          state.cursor = nextSelectable(choices, state.cursor, 1);
          paint();
          return;

        case 'home':
          state.cursor = nextSelectable(choices, choices.length - 1, 1);
          paint();
          return;

        case 'end':
          state.cursor = nextSelectable(choices, 0, -1);
          paint();
          return;

        case 'space':
          if (multi) {
            if (state.checked.has(state.cursor)) state.checked.delete(state.cursor);
            else state.checked.add(state.cursor);
            paint();
          }
          return;

        case 'return':
        case 'enter': {
          const choice = choices[state.cursor];
          if (!isSelectable(choice)) return;
          finish({ status: 'selected', value: choice.value as T, index: state.cursor });
          return;
        }

        case 'escape':
        case 'q':
          finish({ status: 'cancelled' });
          return;

        default: {
          // Digit shortcuts preserve the muscle memory of the numeric menu this
          // replaces: 1-9 jump to the Nth selectable row without confirming.
          const digit = Number.parseInt(key.name ?? '', 10);
          if (Number.isInteger(digit) && digit >= 1 && digit <= 9) {
            const target = nthSelectable(choices, digit);
            if (target !== -1) { state.cursor = target; paint(); }
          }
        }
      }
    }

    activeTeardowns.add(teardown);

    readline.emitKeypressEvents(input);
    if (typeof input.setRawMode === 'function') input.setRawMode(true);
    input.resume();
    input.on('keypress', onKeypress);

    output.write(CURSOR_HIDE);
    paint();
  });
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Opens a single-selection prompt and reports the full outcome.
 *
 * Use this when the caller must distinguish cancellation from an unavailable
 * terminal or a Ctrl+C — for example to fall back to a typed prompt, or to end
 * the session. {@link select} is the simpler form when that distinction does
 * not matter.
 *
 * @typeParam T - The value type carried by the choices.
 * @param opts - Prompt configuration.
 * @returns The outcome of the prompt. Never rejects.
 */
export async function selectOutcome<T>(opts: SelectOptions<T>): Promise<SelectOutcome<T>> {
  const { outcome } = await runPrompt<T>(opts, false);
  return outcome;
}

/**
 * Opens a single-selection prompt and returns the chosen value.
 *
 * @typeParam T - The value type carried by the choices.
 * @param opts - Prompt configuration.
 * @returns The chosen value, or `null` if cancelled, interrupted, or unavailable.
 */
export async function select<T>(opts: SelectOptions<T>): Promise<T | null> {
  const outcome = await selectOutcome(opts);
  return outcome.status === 'selected' ? outcome.value : null;
}

/**
 * Opens a multi-selection prompt where Space toggles rows.
 *
 * @typeParam T - The value type carried by the choices.
 * @param opts - Prompt configuration, including any initially checked rows.
 * @returns The checked values in row order, or `null` if the prompt did not
 *          resolve with Enter. An empty array means the user confirmed with
 *          nothing checked, which is different from cancelling.
 */
export async function multiSelect<T>(opts: MultiSelectOptions<T>): Promise<T[] | null> {
  const { outcome, checked } = await runPrompt<T>(opts, true);
  if (outcome.status !== 'selected') return null;
  return checked
    .filter((i) => isSelectable(opts.choices[i]))
    .map((i) => opts.choices[i].value as T);
}
