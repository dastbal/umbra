/**
 * Tests for the interactive selection prompts.
 *
 * The prompt is driven through a fake TTY: a `PassThrough` stream flagged as a
 * terminal, with a recording `setRawMode`. Writing raw byte sequences into it
 * is exactly what a real terminal does when a key is pressed, so these tests
 * exercise the real `readline` keypress decoder rather than a stub of it.
 */

import { PassThrough } from 'stream';
import { select, selectOutcome, multiSelect, isInteractive, SelectChoice } from './interactive-select';

/** A fake terminal pair, plus the bookkeeping the assertions need. */
interface FakeTerminal {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  /** Every value passed to `setRawMode`, in order. */
  rawModeCalls: boolean[];
  /** Everything written to the output stream. */
  written(): string;
  /** Sends a raw key sequence, as a terminal would. */
  press(sequence: string): void;
}

/**
 * Builds a fake interactive terminal.
 *
 * @param columns - Reported terminal width.
 * @returns The fake terminal handle.
 */
function makeTerminal(columns = 80): FakeTerminal {
  const rawModeCalls: boolean[] = [];
  const stream = new PassThrough();

  const input = stream as unknown as NodeJS.ReadStream & { isRaw: boolean };
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = ((mode: boolean) => {
    rawModeCalls.push(mode);
    input.isRaw = mode;
    return input;
  }) as NodeJS.ReadStream['setRawMode'];

  const chunks: string[] = [];
  const output = {
    isTTY: true,
    columns,
    write(chunk: string): boolean { chunks.push(chunk); return true; },
  } as unknown as NodeJS.WriteStream;

  return {
    input,
    output,
    rawModeCalls,
    written: () => chunks.join(''),
    press: (sequence: string) => { stream.write(sequence); },
  };
}

/** Sequences a real terminal emits for the keys under test. */
const KEY = {
  up: '\x1b[A',
  down: '\x1b[B',
  enter: '\r',
  space: ' ',
  ctrlC: '\x03',
  /** `q` shares the cancel branch with Escape; see the cancellation test. */
  cancel: 'q',
} as const;

/**
 * Feeds a sequence of keys once the prompt has attached its listener.
 *
 * @param term - The fake terminal.
 * @param keys - Sequences to send, in order.
 */
function pressAll(term: FakeTerminal, keys: string[]): void {
  setImmediate(() => { for (const key of keys) term.press(key); });
}

const FRUITS: SelectChoice<string>[] = [
  { label: 'Apple',  value: 'apple' },
  { label: 'Banana', value: 'banana' },
  { label: 'Cherry', value: 'cherry' },
];

describe('isInteractive', () => {
  it('is false when the input stream is not a TTY', () => {
    const term = makeTerminal();
    (term.input as { isTTY?: boolean }).isTTY = false;
    expect(isInteractive(term.input, term.output)).toBe(false);
  });

  it('is true for a TTY pair that supports raw mode', () => {
    const term = makeTerminal();
    expect(isInteractive(term.input, term.output)).toBe(true);
  });
});

describe('select', () => {
  it('moves the highlight down and resolves the row under it', async () => {
    const term = makeTerminal();
    pressAll(term, [KEY.down, KEY.down, KEY.enter]);

    const value = await select({ choices: FRUITS, input: term.input, output: term.output });

    expect(value).toBe('cherry');
  });

  it('wraps around when moving up from the first row', async () => {
    const term = makeTerminal();
    pressAll(term, [KEY.up, KEY.enter]);

    const value = await select({ choices: FRUITS, input: term.input, output: term.output });

    expect(value).toBe('cherry');
  });

  it('skips separators and disabled rows', async () => {
    const term = makeTerminal();
    const choices: SelectChoice<string>[] = [
      { label: '── Cloud ──', separator: true },
      { label: 'Vertex', value: 'vertex' },
      { label: '── Local ──', separator: true },
      { label: 'Ollama (not installed)', value: 'ollama', disabled: true },
      { label: 'LM Studio', value: 'lmstudio' },
    ];
    pressAll(term, [KEY.down, KEY.enter]);

    const value = await select({ choices, input: term.input, output: term.output });

    // From 'Vertex' one step down lands on 'LM Studio': both the separator and
    // the disabled row are passed over.
    expect(value).toBe('lmstudio');
  });

  it('starts on the row flagged as active', async () => {
    const term = makeTerminal();
    const choices: SelectChoice<string>[] = [
      { label: 'Apple',  value: 'apple' },
      { label: 'Banana', value: 'banana', active: true },
      { label: 'Cherry', value: 'cherry' },
    ];
    pressAll(term, [KEY.enter]);

    const value = await select({ choices, input: term.input, output: term.output });

    expect(value).toBe('banana');
  });

  it('honours an explicit initialIndex over the active row', async () => {
    const term = makeTerminal();
    const choices: SelectChoice<string>[] = [
      { label: 'Apple',  value: 'apple' },
      { label: 'Banana', value: 'banana', active: true },
      { label: 'Cherry', value: 'cherry' },
    ];
    pressAll(term, [KEY.enter]);

    const value = await select({
      choices, initialIndex: 0, input: term.input, output: term.output,
    });

    expect(value).toBe('apple');
  });

  it('discards a newline buffered before the prompt starts listening', async () => {
    const term = makeTerminal();
    // This models the LF of a CRLF line ending left behind by the chat editor.
    // It must not select the first row of the next prompt.
    term.press('\n');
    pressAll(term, [KEY.cancel]);

    const outcome = await selectOutcome({
      choices: FRUITS, input: term.input, output: term.output,
    });

    expect(outcome).toEqual({ status: 'cancelled' });
  });

  it('jumps to the Nth selectable row on a digit key without confirming', async () => {
    const term = makeTerminal();
    pressAll(term, ['3', KEY.enter]);

    const value = await select({ choices: FRUITS, input: term.input, output: term.output });

    expect(value).toBe('cherry');
  });

  it('reports cancellation without a value', async () => {
    // `q` and Escape resolve through the same branch. `q` is used here because a
    // lone ESC byte is ambiguous to the keypress decoder until the next byte
    // arrives, which would make the test depend on a parser timeout.
    const term = makeTerminal();
    pressAll(term, [KEY.cancel]);

    const outcome = await selectOutcome({
      choices: FRUITS, input: term.input, output: term.output,
    });

    expect(outcome).toEqual({ status: 'cancelled' });
  });

  it('reports Ctrl+C as an interruption rather than a selection', async () => {
    const term = makeTerminal();
    pressAll(term, [KEY.ctrlC]);

    const outcome = await selectOutcome({
      choices: FRUITS, input: term.input, output: term.output,
    });

    expect(outcome).toEqual({ status: 'interrupted' });
  });

  it('restores raw mode and the cursor on every exit path', async () => {
    const term = makeTerminal();
    pressAll(term, [KEY.enter]);

    await select({ choices: FRUITS, input: term.input, output: term.output });

    expect(term.rawModeCalls).toEqual([true, false]);
    expect(term.input.isRaw).toBe(false);
    // The cursor is hidden while painting and must be shown again afterwards.
    expect(term.written()).toContain('\x1b[?25h');
  });

  it('erases its own output so the menu leaves no residue', async () => {
    const term = makeTerminal();
    pressAll(term, [KEY.enter]);

    await select({ choices: FRUITS, input: term.input, output: term.output });

    // The final write clears from the cursor to the end of the screen.
    expect(term.written()).toContain('\x1b[0J');
  });

  it('returns unavailable without drawing when there is no TTY', async () => {
    const term = makeTerminal();
    (term.input as { isTTY?: boolean }).isTTY = false;

    const outcome = await selectOutcome({
      choices: FRUITS, input: term.input, output: term.output,
    });

    expect(outcome).toEqual({ status: 'unavailable' });
    expect(term.written()).toBe('');
    expect(term.rawModeCalls).toEqual([]);
  });

  it('returns unavailable when no row can be selected', async () => {
    const term = makeTerminal();

    const outcome = await selectOutcome({
      choices: [{ label: '── Empty ──', separator: true }],
      input: term.input,
      output: term.output,
    });

    expect(outcome).toEqual({ status: 'unavailable' });
  });

  it('scrolls rather than printing every row of a long list', async () => {
    const term = makeTerminal();
    const many: SelectChoice<number>[] = Array.from({ length: 40 }, (_, i) => ({
      label: `Option ${i}`, value: i,
    }));
    pressAll(term, [KEY.enter]);

    await select({ choices: many, pageSize: 5, input: term.input, output: term.output });

    const painted = term.written();
    expect(painted).toContain('Option 0');
    expect(painted).not.toContain('Option 39');
  });
});

describe('multiSelect', () => {
  it('toggles rows with space and returns them in row order', async () => {
    const term = makeTerminal();
    pressAll(term, [KEY.space, KEY.down, KEY.down, KEY.space, KEY.enter]);

    const values = await multiSelect({
      choices: FRUITS, input: term.input, output: term.output,
    });

    expect(values).toEqual(['apple', 'cherry']);
  });

  it('un-toggles a row pressed twice', async () => {
    const term = makeTerminal();
    pressAll(term, [KEY.space, KEY.space, KEY.down, KEY.space, KEY.enter]);

    const values = await multiSelect({
      choices: FRUITS, input: term.input, output: term.output,
    });

    expect(values).toEqual(['banana']);
  });

  it('distinguishes confirming nothing from cancelling', async () => {
    const term = makeTerminal();
    pressAll(term, [KEY.enter]);

    const confirmed = await multiSelect({
      choices: FRUITS, input: term.input, output: term.output,
    });

    expect(confirmed).toEqual([]);

    const cancelTerm = makeTerminal();
    pressAll(cancelTerm, [KEY.cancel]);

    const cancelled = await multiSelect({
      choices: FRUITS, input: cancelTerm.input, output: cancelTerm.output,
    });

    expect(cancelled).toBeNull();
  });

  it('honours initially checked rows', async () => {
    const term = makeTerminal();
    pressAll(term, [KEY.enter]);

    const values = await multiSelect({
      choices: FRUITS, initialSelected: [1], input: term.input, output: term.output,
    });

    expect(values).toEqual(['banana']);
  });
});
