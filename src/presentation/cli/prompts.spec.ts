/**
 * Tests for the prompt facade.
 *
 * `select` and `multiSelect` are covered by `interactive-select.spec.ts`; what
 * matters here is the text path and that `confirm` picks the right mechanism for
 * the terminal it is given.
 */

import { PassThrough } from 'stream';
import { askText, askNumber, confirm } from './prompts';

/** A stream pair standing in for a terminal or a pipe. */
interface Streams {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  written(): string;
  send(data: string): void;
}

/**
 * Builds a stream pair.
 *
 * @param isTTY - Whether to present the streams as an interactive terminal.
 * @returns The stream pair handle.
 */
function makeStreams(isTTY: boolean): Streams {
  const stream = new PassThrough();
  const input = stream as unknown as NodeJS.ReadStream & { isRaw: boolean };
  input.isTTY = isTTY;
  input.isRaw = false;
  input.setRawMode = ((mode: boolean) => { input.isRaw = mode; return input; }) as
    NodeJS.ReadStream['setRawMode'];

  // A real stream, not a literal: `readline` subscribes to a TTY output for
  // resize events, so the double has to be an EventEmitter to stand in for one.
  const outStream = new PassThrough();
  const output = outStream as unknown as NodeJS.WriteStream;
  output.isTTY = isTTY;
  (output as unknown as { columns: number }).columns = 80;

  const chunks: string[] = [];
  outStream.on('data', (chunk: Buffer | string) => { chunks.push(String(chunk)); });

  return {
    input,
    output,
    written: () => chunks.join(''),
    send: (data: string) => { stream.write(data); },
  };
}

/**
 * Sends data once the prompt has attached its listener.
 *
 * @param streams - The stream pair.
 * @param data - What to send.
 */
function sendSoon(streams: Streams, data: string): void {
  setImmediate(() => streams.send(data));
}

describe('askText', () => {
  it('reads a line from a pipe, with no TTY needed', async () => {
    // This is why askText is the one primitive that never needs a fallback:
    // line-buffered readline reads a pipe as happily as a keyboard.
    const streams = makeStreams(false);
    sendSoon(streams, 'create a UsersModule\n');

    const answer = await askText({
      prompt: '> ', input: streams.input, output: streams.output,
    });

    expect(answer).toBe('create a UsersModule');
  });

  it('reads a line from a terminal', async () => {
    const streams = makeStreams(true);
    sendSoon(streams, 'hola\n');

    const answer = await askText({
      prompt: '> ', input: streams.input, output: streams.output,
    });

    expect(answer).toBe('hola');
  });

  it('does not trim the answer', async () => {
    // Leading space can be meaningful in a commit message or a prompt, so
    // trimming is the caller's decision to make.
    const streams = makeStreams(false);
    sendSoon(streams, '  spaced  \n');

    const answer = await askText({
      prompt: '> ', input: streams.input, output: streams.output,
    });

    expect(answer).toBe('  spaced  ');
  });

  it('returns an empty string for a bare Enter', async () => {
    const streams = makeStreams(false);
    sendSoon(streams, '\n');

    const answer = await askText({
      prompt: '> ', input: streams.input, output: streams.output,
    });

    // Distinct from null, which means interrupted.
    expect(answer).toBe('');
  });

  it('preserves accented characters and ñ', async () => {
    const streams = makeStreams(false);
    sendSoon(streams, 'añadí una función\n');

    const answer = await askText({
      prompt: '> ', input: streams.input, output: streams.output,
    });

    expect(answer).toBe('añadí una función');
  });
});

describe('askNumber', () => {
  it('parses a number inside the range', async () => {
    const streams = makeStreams(false);
    sendSoon(streams, '3\n');

    const picked = await askNumber('> ', 0, 6, {
      input: streams.input, output: streams.output,
    });

    expect(picked).toBe(3);
  });

  it('rejects a number outside the range', async () => {
    const streams = makeStreams(false);
    sendSoon(streams, '9\n');

    const picked = await askNumber('> ', 0, 6, {
      input: streams.input, output: streams.output,
    });

    expect(picked).toBeNull();
  });

  it('treats an empty answer as a cancellation', async () => {
    const streams = makeStreams(false);
    sendSoon(streams, '\n');

    const picked = await askNumber('> ', 0, 6, {
      input: streams.input, output: streams.output,
    });

    expect(picked).toBeNull();
  });

  it('treats a non-numeric answer as a cancellation', async () => {
    const streams = makeStreams(false);
    sendSoon(streams, 'banana\n');

    const picked = await askNumber('> ', 0, 6, {
      input: streams.input, output: streams.output,
    });

    expect(picked).toBeNull();
  });

  it('accepts the boundaries of the range', async () => {
    const low = makeStreams(false);
    sendSoon(low, '0\n');
    expect(await askNumber('> ', 0, 6, { input: low.input, output: low.output })).toBe(0);

    const high = makeStreams(false);
    sendSoon(high, '6\n');
    expect(await askNumber('> ', 0, 6, { input: high.input, output: high.output })).toBe(6);
  });
});

describe('confirm', () => {
  it('uses the arrow prompt on a terminal', async () => {
    const streams = makeStreams(true);
    // Down then Enter: from the default row to the other one.
    sendSoon(streams, '\x1b[B\r');

    const answer = await confirm({
      question: 'Push it?',
      defaultValue: false,
      input: streams.input,
      output: streams.output,
    });

    expect(answer).toBe(true);
    // The arrow prompt was drawn, not a typed question.
    expect(streams.written()).toContain('Push it?');
  });

  it('opens on the default row so Enter alone is the safe answer', async () => {
    const streams = makeStreams(true);
    sendSoon(streams, '\r');

    const answer = await confirm({
      question: 'Delete everything?',
      defaultValue: false,
      input: streams.input,
      output: streams.output,
    });

    expect(answer).toBe(false);
  });

  it('honours a true default on a terminal', async () => {
    const streams = makeStreams(true);
    sendSoon(streams, '\r');

    const answer = await confirm({
      question: 'Keep going?',
      defaultValue: true,
      input: streams.input,
      output: streams.output,
    });

    expect(answer).toBe(true);
  });

  it('reports a cancelled prompt as null rather than as a no', async () => {
    const streams = makeStreams(true);
    sendSoon(streams, 'q');

    const answer = await confirm({
      question: 'Push it?', input: streams.input, output: streams.output,
    });

    // Callers at a security boundary treat null as a no; others must not.
    expect(answer).toBeNull();
  });

  it('falls back to a typed y/n without a TTY', async () => {
    const streams = makeStreams(false);
    sendSoon(streams, 'y\n');

    const answer = await confirm({
      question: 'Push it?', input: streams.input, output: streams.output,
    });

    expect(answer).toBe(true);
    expect(streams.written()).toContain('[y/N]');
  });

  it('accepts a spelled-out yes and rejects anything else', async () => {
    const yes = makeStreams(false);
    sendSoon(yes, 'YES\n');
    expect(await confirm({
      question: '?', input: yes.input, output: yes.output,
    })).toBe(true);

    const other = makeStreams(false);
    sendSoon(other, 'maybe\n');
    expect(await confirm({
      question: '?', input: other.input, output: other.output,
    })).toBe(false);
  });

  it('applies the default to a bare Enter in the typed fallback', async () => {
    const streams = makeStreams(false);
    sendSoon(streams, '\n');

    const answer = await confirm({
      question: 'Keep going?',
      defaultValue: true,
      input: streams.input,
      output: streams.output,
    });

    expect(answer).toBe(true);
    expect(streams.written()).toContain('[Y/n]');
  });
});
