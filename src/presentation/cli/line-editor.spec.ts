/**
 * Tests for the live line editor.
 *
 * This module reimplements what `readline` gave for free, so most of these
 * tests are regression guards against losing one of those behaviours: editing
 * in the middle of a line, multi-byte characters, the kill shortcuts, history.
 * A defect here means the operator cannot type, which is why the coverage is
 * heavier than for a menu.
 *
 * Keys are delivered one at a time, as a keyboard does. Batching them into a
 * single chunk produced results that a real terminal does not — that is
 * recorded in ADR-012's third amendment.
 */

import { PassThrough } from 'stream';
import { editLine, canEditLive, Suggestion } from './line-editor';

/** A fake terminal for the editor. */
interface Term {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  written(): string;
  send(data: string): void;
}

/**
 * Builds a fake terminal.
 *
 * @param columns - Reported width.
 * @returns The terminal handle.
 */
function makeTerm(columns = 80): Term {
  const inStream = new PassThrough();
  const input = inStream as unknown as NodeJS.ReadStream & { isRaw: boolean };
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = ((mode: boolean) => { input.isRaw = mode; return input; }) as
    NodeJS.ReadStream['setRawMode'];

  const chunks: string[] = [];
  const output = {
    isTTY: true,
    columns,
    write(chunk: string): boolean { chunks.push(chunk); return true; },
  } as unknown as NodeJS.WriteStream;

  return {
    input,
    output,
    written: () => chunks.join(''),
    send: (data: string) => { inStream.write(data); },
  };
}

const KEY = {
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  enter: '\r',
  tab: '\t',
  // Ctrl+G, not Escape: a lone ESC byte emits nothing until another byte
  // arrives, so a test driving Escape would be describing the keypress
  // decoder's ambiguity rather than the editor's behaviour. Both keys share
  // one code path (`dismissPalette`), and Ctrl+G is the one that always lands.
  dismiss: '\x07',
  backspace: '\x7f',
  ctrlA: '\x01',
  ctrlE: '\x05',
  ctrlU: '\x15',
  ctrlK: '\x0b',
  ctrlW: '\x17',
  ctrlC: '\x03',
} as const;

/** The commands the palette offers in these tests. */
const COMMANDS: Suggestion[] = [
  { value: '/model',  hint: 'switch the active LLM model' },
  { value: '/mentor', hint: 'toggle deep mentor mode' },
  { value: '/exit',   hint: 'same as Ctrl+C' },
];

/**
 * Suggests commands for text that looks like a command being typed.
 *
 * @param typed - The current line.
 * @returns Matching rows.
 */
function suggest(typed: string): Suggestion[] {
  if (!typed.startsWith('/') || /\s/.test(typed)) return [];
  return COMMANDS.filter((c) => c.value.startsWith(typed));
}

/**
 * Runs the editor, delivering keys one at a time.
 *
 * @param term - The fake terminal.
 * @param keys - Keys to send before Enter is implied by the caller.
 * @param opts - Extra editor options.
 * @returns The submitted line.
 */
async function run(
  term: Term,
  keys: string[],
  opts: { history?: string[] } = {},
): Promise<string | null> {
  const pending = editLine({
    prompt: 'You: ',
    suggest,
    history: opts.history,
    input: term.input,
    output: term.output,
  });
  for (const key of keys) {
    await new Promise((r) => setTimeout(r, 6));
    term.send(key);
  }
  return pending;
}

describe('canEditLive', () => {
  it('is false without a TTY, so the caller falls back', () => {
    const term = makeTerm();
    (term.input as { isTTY?: boolean }).isTTY = false;
    expect(canEditLive(term.input, term.output)).toBe(false);
  });

  it('is false when UMBRA_SIMPLE_PROMPT opts out', () => {
    // The escape hatch: an operator who hits a bug here keeps working.
    const term = makeTerm();
    process.env.UMBRA_SIMPLE_PROMPT = '1';
    try {
      expect(canEditLive(term.input, term.output)).toBe(false);
    } finally {
      delete process.env.UMBRA_SIMPLE_PROMPT;
    }
  });

  it('is true on a TTY with no opt-out', () => {
    const term = makeTerm();
    expect(canEditLive(term.input, term.output)).toBe(true);
  });
});

describe('editing a line', () => {
  it('submits typed text', async () => {
    const term = makeTerm();
    expect(await run(term, ['h', 'o', 'l', 'a', KEY.enter])).toBe('hola');
  });

  it('keeps accented characters and ñ intact', async () => {
    // The buffer is code points, not UTF-16 units. Indexing by unit would
    // corrupt exactly this input.
    const term = makeTerm();
    const keys = [...'añadí una función', KEY.enter];
    expect(await run(term, keys)).toBe('añadí una función');
  });

  it('backspaces a multi-byte character as one character', async () => {
    const term = makeTerm();
    expect(await run(term, ['a', 'ñ', KEY.backspace, KEY.enter])).toBe('a');
  });

  it('inserts in the middle after moving the cursor', async () => {
    const term = makeTerm();
    const keys = ['a', 'c', KEY.left, 'b', KEY.enter];
    expect(await run(term, keys)).toBe('abc');
  });

  it('deletes backwards from the middle', async () => {
    const term = makeTerm();
    const keys = ['a', 'b', 'c', KEY.left, KEY.backspace, KEY.enter];
    expect(await run(term, keys)).toBe('ac');
  });

  it('moves to the start with Ctrl+A and the end with Ctrl+E', async () => {
    const term = makeTerm();
    const keys = ['b', 'c', KEY.ctrlA, 'a', KEY.ctrlE, 'd', KEY.enter];
    expect(await run(term, keys)).toBe('abcd');
  });

  it('kills to the start with Ctrl+U', async () => {
    const term = makeTerm();
    const keys = ['a', 'b', 'c', KEY.ctrlU, 'x', KEY.enter];
    expect(await run(term, keys)).toBe('x');
  });

  it('kills to the end with Ctrl+K', async () => {
    const term = makeTerm();
    const keys = ['a', 'b', 'c', KEY.left, KEY.ctrlK, KEY.enter];
    expect(await run(term, keys)).toBe('ab');
  });

  it('kills the previous word with Ctrl+W', async () => {
    const term = makeTerm();
    const keys = [...'hola mundo', KEY.ctrlW, KEY.enter];
    expect(await run(term, keys)).toBe('hola ');
  });

  it('submits an empty line as an empty string', async () => {
    const term = makeTerm();
    expect(await run(term, [KEY.enter])).toBe('');
  });

  it('reports Ctrl+C as null and restores raw mode', async () => {
    const term = makeTerm();
    const line = await run(term, [KEY.ctrlC]);

    expect(line).toBeNull();
    expect((term.input as unknown as { isRaw: boolean }).isRaw).toBe(false);
    expect(term.written()).toContain('\x1b[?25h');
  });
});

describe('the live palette', () => {
  it('opens on a slash and shows every command', async () => {
    const term = makeTerm();
    const pending = run(term, ['/']);
    await new Promise((r) => setTimeout(r, 30));

    const painted = term.written();
    expect(painted).toContain('/model');
    expect(painted).toContain('/mentor');
    expect(painted).toContain('/exit');
    // The pointer the operator moves with the arrow keys.
    expect(painted).toContain('❯');

    term.send(KEY.ctrlC);
    await pending;
  });

  it('filters as more is typed', async () => {
    const term = makeTerm();
    const pending = run(term, ['/', 'm', 'o']);
    await new Promise((r) => setTimeout(r, 30));

    // The last paint is what the operator is looking at.
    const lastPaint = term.written().split('You: ').pop() ?? '';
    expect(lastPaint).toContain('/model');
    expect(lastPaint).not.toContain('/exit');

    term.send(KEY.ctrlC);
    await pending;
  });

  it('stays closed for ordinary prose', async () => {
    const term = makeTerm();
    const pending = run(term, [...'create a module']);
    await new Promise((r) => setTimeout(r, 40));

    expect(term.written()).not.toContain('❯');

    term.send(KEY.ctrlC);
    await pending;
  });

  it('accepts the highlighted row on Enter', async () => {
    const term = makeTerm();
    // The first row is highlighted on open, so Enter takes it.
    expect(await run(term, ['/', 'm', 'o', KEY.enter])).toBe('/model');
  });

  it('moves the highlight down and takes that row instead', async () => {
    const term = makeTerm();
    const keys = ['/', 'm', KEY.down, KEY.enter];
    expect(await run(term, keys)).toBe('/mentor');
  });

  it('wraps the highlight upward from the first row', async () => {
    const term = makeTerm();
    const keys = ['/', KEY.up, KEY.enter];
    expect(await run(term, keys)).toBe('/exit');
  });

  it('completes the highlighted row on Tab without submitting', async () => {
    const term = makeTerm();
    const keys = ['/', 'm', KEY.tab, KEY.enter];
    expect(await run(term, keys)).toBe('/model');
  });

  it('dismisses the palette while keeping the typed text', async () => {
    const term = makeTerm();
    const keys = ['/', 'm', 'o', KEY.dismiss, KEY.enter];

    // Dismissing closes the palette; Enter then submits what was typed rather
    // than the suggestion, because there is no longer a highlighted row.
    expect(await run(term, keys)).toBe('/mo');
  });

  it('reopens after a dismiss once the text changes', async () => {
    const term = makeTerm();
    const keys = ['/', 'm', KEY.dismiss, 'o', KEY.enter];

    // The dismissal applies to the text that was dismissed, not to the prompt
    // forever — typing again is a new intent.
    expect(await run(term, keys)).toBe('/model');
  });
});

describe('history', () => {
  it('recalls the previous line with up', async () => {
    const term = makeTerm();
    const keys = [KEY.up, KEY.enter];

    expect(await run(term, keys, { history: ['first', 'second'] })).toBe('second');
  });

  it('walks further back with repeated ups', async () => {
    const term = makeTerm();
    const keys = [KEY.up, KEY.up, KEY.enter];

    expect(await run(term, keys, { history: ['first', 'second'] })).toBe('first');
  });

  it('returns to the draft on the way back down', async () => {
    const term = makeTerm();
    const keys = ['w', 'i', 'p', KEY.up, KEY.down, KEY.enter];

    // The in-progress line must survive a trip into history.
    expect(await run(term, keys, { history: ['old'] })).toBe('wip');
  });

  it('does not consume up when the palette is open', async () => {
    const term = makeTerm();
    // With the palette open, up moves the highlight rather than reaching history.
    const keys = ['/', 'm', KEY.up, KEY.enter];

    expect(await run(term, keys, { history: ['old'] })).toBe('/mentor');
  });
});
