/**
 * @module StreamRendererSpec
 *
 * Contract tests for the animated wait indicator.
 *
 * These assert the *mechanics* that make the animation safe — line width,
 * erasure, timer lifecycle, non-interactive degradation — not the colours.
 * Chalk reports level 0 under Jest, so every assertion is made on ANSI-stripped
 * text and would hold identically in a colour-capable terminal.
 */

import { StreamRenderer } from './stream-renderer';

/** Remove every SGR escape so assertions describe what a user actually reads. */
const strip = (s: string): string => s.replace(/\[[0-9;]*m/g, '');

/**
 * Longest printable transient line — one written with a leading `\r`, meaning
 * it will be repainted or erased in place.
 *
 * Static lines are deliberately excluded: they scroll away harmlessly if they
 * wrap. It is the repainted ones that corrupt the screen, because `\r` returns
 * to the start of the *last* row only and strands every row above it.
 */
const widestTransientLine = (writes: string[]): number =>
  Math.max(
    0,
    ...writes
      .filter((w) => w.startsWith('\r'))
      .flatMap((w) => strip(w).split(/[\r\n]/))
      .map((l) => l.length),
  );

describe('StreamRenderer — wait indicator', () => {
  let writes: string[];
  let spy: jest.SpyInstance;
  const originalTty = process.stdout.isTTY;
  const originalColumns = process.stdout.columns;

  beforeEach(() => {
    writes = [];
    spy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: unknown): boolean => {
        writes.push(String(chunk));
        return true;
      });
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    spy.mockRestore();
    process.stdout.isTTY = originalTty;
    process.stdout.columns = originalColumns;
  });

  describe('on an interactive terminal', () => {
    beforeEach(() => {
      process.stdout.isTTY = true;
      process.stdout.columns = 100;
    });

    it('repaints the phrase on a timer instead of writing it once', () => {
      const renderer = new StreamRenderer('deep');
      renderer.showThinking();
      const afterFirstPaint = writes.length;

      jest.advanceTimersByTime(600); // 10 frames at 60ms

      expect(writes.length).toBeGreaterThan(afterFirstPaint);
      expect(strip(writes.join(''))).toContain('Thinking');
      renderer.clearThinking();
    });

    it('erases its line using the real width, not a fixed 80 columns', () => {
      const renderer = new StreamRenderer('deep');
      renderer.showThinking();
      jest.advanceTimersByTime(120);

      const lastFrame = strip(writes[writes.length - 1]).replace('\r', '');
      writes.length = 0;
      renderer.clearThinking();

      const cleared = writes.join('');
      const blanks = (cleared.match(/ /g) ?? []).length;
      expect(cleared.startsWith('\r')).toBe(true);
      expect(cleared.endsWith('\r')).toBe(true);
      expect(blanks).toBe(lastFrame.length);
    });

    it('never emits a line wider than the terminal, so it cannot wrap', () => {
      process.stdout.columns = 34; // narrower than "Writing the response"
      const renderer = new StreamRenderer('deep');
      renderer.showThinking();
      renderer.streamToken('hello');
      jest.advanceTimersByTime(600);

      expect(widestTransientLine(writes)).toBeLessThanOrEqual(34);
      renderer.clearThinking();
    });

    it('switches phrase without restarting the animation', () => {
      const renderer = new StreamRenderer('deep');
      renderer.showThinking('think');
      jest.advanceTimersByTime(300);
      writes.length = 0;

      renderer.setThinkingPhase('write');
      jest.advanceTimersByTime(120);

      const text = strip(writes.join(''));
      expect(text).toContain('Writing the response');
      expect(text).not.toContain('Thinking');
      renderer.clearThinking();
    });

    it('stops the timer when cleared, leaving nothing to repaint', () => {
      const renderer = new StreamRenderer('deep');
      renderer.showThinking();
      jest.advanceTimersByTime(120);
      renderer.clearThinking();
      writes.length = 0;

      jest.advanceTimersByTime(1200);

      expect(writes).toHaveLength(0);
    });

    // Renamed from "tokens" deliberately. The provider decides chunk
    // boundaries, so this counter never measured billing units; calling them
    // tokens next to a real token count would be two different numbers under
    // one name.
    it('counts stream chunks while writing rather than printing one dot each', () => {
      const renderer = new StreamRenderer('deep');
      renderer.showThinking();
      for (let i = 0; i < 40; i++) renderer.streamToken('tok ');
      jest.advanceTimersByTime(120);

      const text = strip(writes.join(''));
      expect(text).toContain('40 chunks');
      // The old renderer emitted one '.' per token — 40 of them in a row.
      expect(text).not.toContain('.'.repeat(10));
      renderer.clearThinking();
    });

    it('shows real spend, and prefers it over the chunk counter', () => {
      const renderer = new StreamRenderer('deep');
      renderer.showThinking();
      renderer.streamToken('tok ');
      renderer.noteTurnSpend({ toolCalls: 7, tokens: 51_000, costUsd: 0.0846 });
      jest.advanceTimersByTime(120);

      const text = strip(writes.join(''));
      expect(text).toContain('7 calls');
      expect(text).toContain('51.0k tok');
      expect(text).toContain('$0.0846');
      expect(text).not.toContain('chunks');
      renderer.clearThinking();
    });

    // An unpriced model must show no figure rather than a false zero.
    it('omits cost entirely when the model has no published price', () => {
      const renderer = new StreamRenderer('deep');
      renderer.showThinking();
      renderer.noteTurnSpend({ toolCalls: 2, tokens: 900 });
      jest.advanceTimersByTime(120);

      const text = strip(writes.join(''));
      expect(text).toContain('2 calls');
      expect(text).toContain('900 tok');
      expect(text).not.toContain('$');
      renderer.clearThinking();
    });

    it('drops back to the chunk counter once the turn spend is reset', () => {
      const renderer = new StreamRenderer('deep');
      renderer.showThinking();
      renderer.noteTurnSpend({ toolCalls: 3, tokens: 10 });
      renderer.resetTurnSpend();
      renderer.streamToken('a');
      jest.advanceTimersByTime(120);

      expect(strip(writes.join(''))).toContain('1 chunks');
      renderer.clearThinking();
    });
  });

  describe('on non-interactive stdout', () => {
    beforeEach(() => {
      process.stdout.isTTY = false;
      process.stdout.columns = 100;
    });

    it('states the phrase once and starts no timer', () => {
      const renderer = new StreamRenderer('deep');
      renderer.showThinking();
      const afterStart = writes.length;

      jest.advanceTimersByTime(3000);

      expect(writes.length).toBe(afterStart);
      expect(strip(writes.join(''))).toContain('Thinking');
    });

    it('never emits a carriage return, so piped logs stay readable', () => {
      const renderer = new StreamRenderer('deep');
      renderer.showThinking();
      renderer.showToolStart('safe_read_file', { file_path: 'a.ts' });
      renderer.showToolEnd('safe_read_file');
      renderer.finalizeTurn();

      expect(writes.join('')).not.toContain('\r');
    });

    it('describes what the tool is doing, not just its name', () => {
      const renderer = new StreamRenderer('deep');
      renderer.showToolStart('ask_codebase', { query: 'auth' });

      expect(strip(writes.join(''))).toContain('Searching the codebase');
      renderer.finalizeTurn();
    });
  });
});

describe('showTurnSpend', () => {
  /** Captures what the renderer wrote to stdout. */
  function captured(spend: {
    toolCalls: number;
    tokens: number;
    costUsd?: number;
    reasoningTokens?: number;
    reasoningCostUsd?: number;
  }): string {
    const written: string[] = [];
    const write = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });

    try {
      new StreamRenderer('orchestrate').showTurnSpend(spend);
    } finally {
      write.mockRestore();
    }

    return written.join('');
  }

  it('leaves the price on screen after the turn ends', () => {
    // The wait indicator is transient by contract, so the counter it carried
    // was erased exactly when the operator could read it. Fast turns made that
    // total: the cheaper the work became, the more completely its price
    // disappeared.
    const line = captured({ toolCalls: 3, tokens: 12_400, costUsd: 0.0041 });

    expect(line).toContain('3 calls');
    expect(line).toContain('12.4k tok');
    expect(line).toContain('$0.0041');
  });

  it('shows what the turn paid for thinking nobody sees', () => {
    // Since the ADR-006 amendment the reasoning is generated, billed and never
    // printed. One measured call spent 601 of 670 completion tokens that way,
    // so the share belongs beside the total rather than inside it.
    const line = captured({
      toolCalls: 1,
      tokens: 12_400,
      costUsd: 0.0041,
      reasoningTokens: 6_010,
      reasoningCostUsd: 0.0012,
    });

    expect(line).toContain('6.0k thinking $0.0012');
    expect(line).toContain('$0.0041');
  });

  it('says nothing about thinking when the provider reported none', () => {
    // Anthropic publishes no breakdown. A '0 thinking' would claim the model
    // did not think, when the truth is that nobody said.
    const line = captured({ toolCalls: 1, tokens: 900, costUsd: 0.0002, reasoningTokens: 0 });

    expect(line).not.toContain('thinking');
  });

  it('prints the share even when the model has no published price', () => {
    const line = captured({ toolCalls: 1, tokens: 900, reasoningTokens: 400 });

    expect(line).toContain('400 thinking');
    expect(line).not.toContain('$');
  });

  it('omits the cost for an unpriced model instead of printing zero', () => {
    const line = captured({ toolCalls: 1, tokens: 900 });

    expect(line).toContain('1 call');
    expect(line).not.toContain('$');
  });

  it('says nothing for a turn that spent nothing', () => {
    // A greeting answered locally has no price to report, and a line reading
    // "0 calls" on every hello is noise.
    expect(captured({ toolCalls: 0, tokens: 0 })).toBe('');
  });
});
