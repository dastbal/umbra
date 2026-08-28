/**
 * @module StreamRendererScreenSpec
 *
 * Screen-level regression test for the CLI renderer.
 *
 * The unit tests in `stream-renderer.spec.ts` assert what the renderer *writes*.
 * This one asserts what a terminal ends up *showing*, by replaying the byte
 * stream through a minimal screen emulator that honours `\r` and `\n` and wraps
 * at a fixed width.
 *
 * That distinction matters: every defect this indicator was built to fix —
 * stranded rows of dots, a spinner tail surviving its own erasure — is invisible
 * at the write level and obvious at the screen level.
 */

import { StreamRenderer } from './stream-renderer';

/**
 * Replay a raw stdout stream onto a fixed-width screen.
 *
 * Models only what the renderer relies on: `\r` returns to column zero of the
 * current row, `\n` starts a new row, and printable characters overwrite in
 * place, wrapping at `width`.
 *
 * @param stream - Everything written to stdout, escapes included.
 * @param width - Terminal width in columns.
 * @returns The visible rows, right-trimmed.
 */
function renderScreen(stream: string, width: number): string[] {
  const rows: string[][] = [[]];
  let row = 0;
  let col = 0;

  for (const ch of stream.replace(/\[[0-9;]*m/g, '')) {
    if (ch === '\r') {
      col = 0;
      continue;
    }
    if (ch === '\n') {
      row++;
      col = 0;
      if (!rows[row]) rows[row] = [];
      continue;
    }
    while (rows[row].length < col) rows[row].push(' ');
    rows[row][col] = ch;
    col++;
    if (col >= width) {
      row++;
      col = 0;
      if (!rows[row]) rows[row] = [];
    }
  }

  return rows.map((r) => r.join('').replace(/\s+$/, ''));
}

describe('StreamRenderer — resulting screen', () => {
  const WIDTH = 100;

  /**
   * Drive a complete turn — wait, tool call, token stream, finalize — and
   * return what the terminal is left displaying.
   */
  function playTurn(tokenCount: number): string[] {
    const writes: string[] = [];
    const spy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: unknown): boolean => {
        writes.push(String(chunk));
        return true;
      });

    const originalTty = process.stdout.isTTY;
    const originalColumns = process.stdout.columns;
    process.stdout.isTTY = true;
    process.stdout.columns = WIDTH;
    jest.useFakeTimers();

    try {
      const renderer = new StreamRenderer('deep');
      renderer.showThinking();
      jest.advanceTimersByTime(900);
      renderer.showToolStart('ask_codebase', { query: 'cli renderer' });
      // Long enough for the elapsed counter to shrink from "990ms" to "1.0s"
      jest.advanceTimersByTime(1200);
      renderer.showToolEnd('ask_codebase');
      jest.advanceTimersByTime(600);
      for (let i = 0; i < tokenCount; i++) renderer.streamToken('word ');
      jest.advanceTimersByTime(600);
      renderer.finalizeTurn();
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
      process.stdout.isTTY = originalTty;
      process.stdout.columns = originalColumns;
      spy.mockRestore();
    }

    return renderScreen(writes.join(''), WIDTH);
  }

  it('leaves no wait indicator behind once the turn is finalized', () => {
    const screen = playTurn(320).join('\n');

    expect(screen).not.toContain('Thinking');
    expect(screen).not.toContain('Writing the response');
    expect(screen).not.toContain('Searching the codebase');
  });

  it('strands no rows of placeholder dots on a long response', () => {
    // The previous renderer wrote one dot per token. At 320 tokens that wrapped
    // across four rows, and its fixed 80-column clear erased only the last one.
    const screen = playTurn(320);

    expect(screen.some((line) => line.includes('....'))).toBe(false);
  });

  it('closes the tool box without a tail from the spinner line', () => {
    const done = playTurn(20).find((line) => line.includes('done in'));

    expect(done).toBeDefined();
    // Anything after the duration is residue from a wider previous frame.
    expect(done).toMatch(/done in \d+(\.\d+)?(ms|s)$/);
  });

  it('still prints the response body and the turn summary', () => {
    const screen = playTurn(20).join('\n');

    expect(screen).toContain('word word');
    expect(screen).toContain('1 tool call executed');
  });
});
