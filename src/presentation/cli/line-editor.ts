/**
 * @module LineEditor
 *
 * A line editor with a live suggestion palette underneath it.
 *
 * Typing `/` opens a dimmed list below the prompt that filters as more is
 * typed, navigable with the arrow keys. This is the interaction `readline`
 * cannot provide, and the reason is worth stating plainly: `readline` only
 * hands over a line once Enter is pressed. To show something *while* the
 * operator types, the process has to see every keystroke, which means raw mode
 * — and in raw mode `readline` cannot be the reader. Everything it gave for
 * free has to be provided here instead.
 *
 * ## What that "for free" list actually contains
 *
 * Backspace, delete, cursor movement, Home/End, the `Ctrl+A/E/U/K/W` word and
 * line kills, history on `↑↓`, and correct handling of characters that are more
 * than one byte — `á`, `ñ`, an emoji. Each is implemented below. Losing any of
 * them would be a regression against the plain prompt this replaces.
 *
 * ## The risk, and the way out
 *
 * `readline` is the input path for the **entire session**, not for one menu. A
 * defect in a menu breaks a menu; a defect here means the operator cannot type
 * at all. Two deliberate mitigations:
 *
 * - Without a TTY this module is never used — the caller falls back to
 *   `askText`, exactly as every other prompt does.
 * - `UMBRA_SIMPLE_PROMPT=1` forces that same fallback on a real terminal, so an
 *   operator who hits a problem here can keep working without waiting for a fix.
 *
 * ## Text is edited as code points, never as bytes
 *
 * The buffer is an array of code points (`Array.from`), not a string index.
 * `'añadí'.length` counts UTF-16 units, so byte or unit indexing puts the
 * cursor inside a character and backspace corrupts it. Spanish input would be
 * the first casualty; this is not a theoretical concern for this project.
 *
 * @example
 * ```ts
 * const line = await editLine({
 *   prompt: 'You: ',
 *   suggest: (text) => text.startsWith('/') ? commandRows(text) : [],
 *   history,
 * });
 * ```
 */

import * as readline from 'readline';
import chalk from 'chalk';
import { colors } from './theme';
import { isInteractive } from './interactive-select';

// ── ANSI ─────────────────────────────────────────────────────────────────────

const ESC = '\x1b';
const CURSOR_SHOW = `${ESC}[?25h`;
const CLEAR_DOWN  = `${ESC}[0J`;
const COLUMN_ZERO = '\r';

/**
 * Moves the cursor up.
 *
 * @param n - Rows to move. Zero yields an empty string.
 * @returns The escape sequence.
 */
function up(n: number): string {
  return n > 0 ? `${ESC}[${n}A` : '';
}

/**
 * Moves the cursor right.
 *
 * @param n - Columns to move. Zero yields an empty string.
 * @returns The escape sequence.
 */
function right(n: number): string {
  return n > 0 ? `${ESC}[${n}C` : '';
}

/** Matches ANSI escape sequences, so styled text can be measured. */
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;]*[A-Za-z]/g;

/**
 * Measures the printed width of styled text.
 *
 * Escape sequences occupy no columns, so the cursor cannot be positioned from
 * a styled string's `.length`.
 *
 * @param text - Possibly styled text.
 * @returns The number of columns it occupies.
 */
function visibleWidth(text: string): number {
  return Array.from(text.replace(ANSI_PATTERN, '')).length;
}

// ── Public types ─────────────────────────────────────────────────────────────

/**
 * One row of the live suggestion palette.
 */
export interface Suggestion {
  /** The text inserted when this row is accepted. */
  value: string;
  /** The text shown. Defaults to `value`. */
  label?: string;
  /** Dimmed detail shown after the label. */
  hint?: string;
}

/**
 * Configuration for {@link editLine}.
 */
export interface EditLineOptions {
  /** The prompt, already styled. Must not contain a newline. */
  prompt: string;
  /**
   * Produces the suggestions for the current text, called on every keystroke.
   *
   * Must be cheap and synchronous — it runs between a key press and the
   * repaint. Returning an empty array closes the palette.
   *
   * @param text - The current line.
   * @returns The rows to show.
   */
  suggest?: (text: string) => Suggestion[];
  /**
   * Previously submitted lines, oldest first. Navigated with `↑↓` when the
   * palette is closed. Not mutated.
   */
  history?: string[];
  /** Rows of palette shown at once. @default 6 */
  maxSuggestions?: number;
  /** Called on Ctrl+C. Without one, Ctrl+C resolves the line as `null`. */
  onInterrupt?: () => void;
  /** Input stream. Overridable for tests. @default process.stdin */
  input?: NodeJS.ReadStream;
  /** Output stream. Overridable for tests. @default process.stdout */
  output?: NodeJS.WriteStream;
}

/**
 * Reports whether the live editor should be used at all.
 *
 * Both conditions are escape hatches rather than optimizations: without a TTY
 * the editor cannot work, and `UMBRA_SIMPLE_PROMPT` lets an operator opt out of
 * it on a real terminal without waiting for a fix.
 *
 * @param input - Input stream to test. @default process.stdin
 * @param output - Output stream to test. @default process.stdout
 * @returns True when the live editor can and should run.
 */
export function canEditLive(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): boolean {
  if (process.env.UMBRA_SIMPLE_PROMPT === '1') return false;
  return isInteractive(input, output);
}

// ── The editor ───────────────────────────────────────────────────────────────

/**
 * Reads one line, showing a live suggestion palette beneath the prompt.
 *
 * Owns stdin while open, and restores the terminal on every exit path. Callers
 * must check {@link canEditLive} first and fall back to `askText` otherwise.
 *
 * @param opts - Editor configuration.
 * @returns The submitted line, or `null` if the operator pressed Ctrl+C.
 */
export function editLine(opts: EditLineOptions): Promise<string | null> {
  const input  = opts.input  ?? process.stdin;
  const output = opts.output ?? process.stdout;

  const promptWidth   = visibleWidth(opts.prompt);
  const maxRows       = Math.max(1, opts.maxSuggestions ?? 6);
  const history       = [...(opts.history ?? [])];
  const terminalWidth = Math.max(20, (output.columns ?? 80));

  /** The line being edited, as code points. */
  let buffer: string[] = [];
  /** Cursor position, as an index into `buffer`. */
  let cursor = 0;
  /** Rows currently shown in the palette. */
  let rows: Suggestion[] = [];
  /** Highlighted palette row, or -1 when the palette is closed. */
  let selected = -1;
  /** Palette rows drawn by the last paint, needed to erase them. */
  let drawnRows = 0;
  /** Position in `history`; equals `history.length` when not browsing. */
  let historyIndex = history.length;
  /** The in-progress line, stashed while browsing history. */
  let draft = '';
  /** Set when the operator dismissed the palette for the current text. */
  let dismissed = false;

  /** @returns The current line as a string. */
  const text = (): string => buffer.join('');

  /** Recomputes the palette for the current text. */
  const refresh = (): void => {
    const next = dismissed ? [] : (opts.suggest?.(text()) ?? []);
    rows = next.slice(0, maxRows);
    // Keep the highlight only while there is something to highlight, and reset
    // it to the first row whenever the filtered set changes.
    selected = rows.length > 0 ? 0 : -1;
  };

  /**
   * Builds the palette lines.
   *
   * @returns The styled rows, already fitted to the terminal.
   */
  const paletteLines = (): string[] =>
    rows.map((row, i) => {
      const isCursor = i === selected;
      const pointer  = isCursor ? colors.primary.bold('❯') : ' ';
      const label    = row.label ?? row.value;
      const budget   = terminalWidth - 6 - (row.hint ? row.hint.length + 2 : 0);
      const shown    = label.length > budget ? label.slice(0, Math.max(4, budget - 1)) + '…' : label;
      // Unselected rows stay deliberately faint: the palette is a hint under
      // the line being typed, not a menu competing with it.
      const styled   = isCursor ? chalk.white.bold(shown) : colors.muted(shown);
      const hint     = row.hint ? colors.dim(`  ${row.hint}`) : '';
      return `  ${pointer} ${styled}${hint}`;
    });

  /**
   * Repaints the prompt line and the palette, leaving the cursor in place.
   *
   * The cursor lands where the operator expects it — inside the text — while
   * the palette sits below, which is the whole point and the fiddly part.
   */
  const paint = (): void => {
    let out = '';

    // Return to the prompt line and clear everything below it.
    out += up(drawnRows) + COLUMN_ZERO + CLEAR_DOWN;
    out += opts.prompt + text();

    const lines = paletteLines();
    if (lines.length > 0) out += '\n' + lines.join('\n');
    drawnRows = lines.length;

    // Put the cursor back into the text.
    out += up(drawnRows) + COLUMN_ZERO + right(promptWidth + cursor);

    output.write(out);
  };

  /** Inserts text at the cursor. */
  const insert = (chunk: string): void => {
    const points = Array.from(chunk);
    buffer.splice(cursor, 0, ...points);
    cursor += points.length;
    dismissed = false;
    refresh();
  };

  /** Replaces the whole line, putting the cursor at the end. */
  const replaceLine = (value: string): void => {
    buffer = Array.from(value);
    cursor = buffer.length;
    dismissed = false;
    refresh();
  };

  /** Accepts the highlighted suggestion into the line. */
  const acceptSuggestion = (): void => {
    if (selected < 0 || !rows[selected]) return;
    replaceLine(rows[selected].value);
    // Accepting resolves the ambiguity, so the palette has nothing left to add.
    rows = [];
    selected = -1;
  };

  /**
   * Closes the palette without touching the typed text.
   *
   * The `dismissed` flag is what stops the next repaint from immediately
   * reopening it; typing anything clears the flag, because new text is a new
   * intent rather than a continuation of the dismissal.
   */
  const dismissPalette = (): void => {
    if (rows.length === 0) return;
    rows = [];
    selected = -1;
    dismissed = true;
  };

  /**
   * Finds the start of the word before the cursor.
   *
   * @returns The index to delete back to.
   */
  const wordStart = (): number => {
    let i = cursor;
    while (i > 0 && buffer[i - 1] === ' ') i--;
    while (i > 0 && buffer[i - 1] !== ' ') i--;
    return i;
  };

  return new Promise<string | null>((resolve) => {
    const wasRaw = Boolean(input.isRaw);
    let settled = false;

    /** Restores the terminal and detaches listeners. Idempotent. */
    const teardown = (): void => {
      if (settled) return;
      settled = true;
      input.removeListener('keypress', onKeypress);
      try {
        if (typeof input.setRawMode === 'function') input.setRawMode(wasRaw);
      } catch { /* the stream may already be closed */ }
      input.pause();
      output.write(CURSOR_SHOW);
    };

    /**
     * Closes the editor, leaving the submitted line on screen without the
     * palette under it.
     *
     * @param value - The line, or `null` when interrupted.
     */
    const finish = (value: string | null): void => {
      // Erase the palette, redraw the bare line, and move past it.
      output.write(up(drawnRows) + COLUMN_ZERO + CLEAR_DOWN + opts.prompt + text() + '\n');
      drawnRows = 0;
      teardown();
      resolve(value);
    };

    /**
     * Handles one decoded keystroke.
     *
     * @param str - The literal string for the key, if printable.
     * @param key - The decoded descriptor from readline.
     */
    function onKeypress(str: string | undefined, key: readline.Key | undefined): void {
      if (!key) return;

      // Raw mode suppresses SIGINT, so Ctrl+C is an ordinary key here.
      if (key.ctrl && key.name === 'c') {
        opts.onInterrupt?.();
        finish(null);
        return;
      }

      if (key.ctrl) {
        switch (key.name) {
          case 'g':
            // Guaranteed dismiss. Escape is offered too, but a lone ESC byte is
            // ambiguous to the keypress decoder: with no `readline.Interface`
            // supplying an escape timeout, it emits nothing until another byte
            // arrives, so Escape can appear not to respond to the first press.
            // Ctrl+G is a single unambiguous byte and always lands.
            dismissPalette();
            break;
          case 'a': cursor = 0; break;
          case 'e': cursor = buffer.length; break;
          case 'u': buffer.splice(0, cursor); cursor = 0; refresh(); break;
          case 'k': buffer.splice(cursor); refresh(); break;
          case 'w': {
            const start = wordStart();
            buffer.splice(start, cursor - start);
            cursor = start;
            refresh();
            break;
          }
          case 'd': if (cursor < buffer.length) { buffer.splice(cursor, 1); refresh(); } break;
          default: return;
        }
        paint();
        return;
      }

      switch (key.name) {
        case 'return':
        case 'enter':
          // With the palette open, Enter takes the highlighted command and
          // submits it — the fast path for "I meant that one".
          if (selected >= 0 && rows[selected]) acceptSuggestion();
          finish(text());
          return;

        case 'backspace':
          if (cursor > 0) { buffer.splice(cursor - 1, 1); cursor--; dismissed = false; refresh(); }
          paint();
          return;

        case 'delete':
          if (cursor < buffer.length) { buffer.splice(cursor, 1); refresh(); }
          paint();
          return;

        case 'left':
          if (cursor > 0) cursor--;
          paint();
          return;

        case 'right':
          if (cursor < buffer.length) cursor++;
          paint();
          return;

        case 'home': cursor = 0; paint(); return;
        case 'end':  cursor = buffer.length; paint(); return;

        case 'tab':
          // Tab and the palette agree: both take the highlighted row.
          if (rows.length > 0) { acceptSuggestion(); paint(); }
          return;

        case 'escape':
          // See the Ctrl+G note above: a lone ESC may not reach us promptly.
          dismissPalette();
          paint();
          return;

        case 'up':
          if (rows.length > 0) {
            selected = (selected - 1 + rows.length) % rows.length;
          } else if (historyIndex > 0) {
            // Stash the draft on the way into history, so it survives coming back.
            if (historyIndex === history.length) draft = text();
            historyIndex--;
            replaceLine(history[historyIndex]);
          }
          paint();
          return;

        case 'down':
          if (rows.length > 0) {
            selected = (selected + 1) % rows.length;
          } else if (historyIndex < history.length) {
            historyIndex++;
            replaceLine(historyIndex === history.length ? draft : history[historyIndex]);
          }
          paint();
          return;

        default:
          // Printable input. `str` carries the whole character, so multi-byte
          // ones arrive intact rather than as pieces.
          if (str && !key.meta && str >= ' ' && str !== '\x7f') {
            insert(str);
            paint();
          }
      }
    }

    readline.emitKeypressEvents(input);
    if (typeof input.setRawMode === 'function') input.setRawMode(true);
    input.resume();
    input.on('keypress', onKeypress);

    output.write(CURSOR_SHOW);
    refresh();
    paint();
  });
}
