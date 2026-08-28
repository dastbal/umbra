import { buildWelcomeBanner } from './theme';

/** Strips styling and zero-width selectors so columns can be counted. */
function plain(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/[︀-️]/gu, '');
}

/** Counts terminal columns, charging emoji the two they actually occupy. */
function columns(line: string): number {
  const text = plain(line);
  const wide = (text.match(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) ?? []).length;
  return Array.from(text).length + wide;
}

/** The banner's rendered lines, without the blank line at each end. */
function bannerLines(...args: Parameters<typeof buildWelcomeBanner>): string[] {
  return buildWelcomeBanner(...args).split('\n').filter((line) => line.trim() !== '');
}

describe('buildWelcomeBanner', () => {
  it('closes the box on every line, emoji included', () => {
    // The right edge used to sit one column off on any line with an emoji,
    // because a code-point count reports a two-column glyph as one.
    const cases: Array<Parameters<typeof buildWelcomeBanner>> = [
      ['deep', 'vertex-anthropic:claude-opus-5', undefined, 'xhigh'],
      ['deep', 'vertex-anthropic:claude-haiku-4-5@20251001', 'refactor-auth', 'medium'],
      ['orchestrate', 'gemini-3.5-flash', undefined, 'minimal'],
      ['deep', 'ollama:gemma4', undefined, undefined],
      ['deep', 'ollama:a-very-long-local-model-name-that-overflows', undefined, undefined],
    ];

    for (const args of cases) {
      const lines = bannerLines(...args);
      const widths = lines.map(columns);
      expect(new Set(widths).size).toBe(1);

      for (const line of lines.slice(1, -1)) {
        expect(plain(line).startsWith('│')).toBe(true);
        expect(plain(line).endsWith('│')).toBe(true);
      }
    }
  });

  it('stays two content lines regardless of what it reports', () => {
    // The banner reprints on every model switch, so its length is a running
    // cost rather than a one-time one.
    const lines = bannerLines('deep', 'vertex-anthropic:claude-opus-5', 'work', 'max');
    expect(lines).toHaveLength(4); // top border, two content lines, bottom border
  });

  it('shows the reasoning level, which silently drives cost', () => {
    const banner = plain(buildWelcomeBanner('deep', 'vertex-anthropic:claude-opus-5', undefined, 'xhigh'));
    expect(banner).toContain('reasoning xhigh');
  });

  it('omits the reasoning line for a model that has no such control', () => {
    const banner = plain(buildWelcomeBanner('deep', 'ollama:gemma4', undefined, undefined));
    expect(banner).not.toContain('reasoning');
  });

  it('drops the routing prefix and the dated Vertex suffix from the model name', () => {
    const banner = plain(
      buildWelcomeBanner('deep', 'vertex-anthropic:claude-haiku-4-5@20251001', undefined, 'low'),
    );
    expect(banner).toContain('claude-haiku-4-5');
    expect(banner).not.toContain('vertex-anthropic:');
    expect(banner).not.toContain('@20251001');
  });

  it('names the session when one is being continued', () => {
    expect(plain(buildWelcomeBanner('deep', 'gemini-3.5-flash', 'refactor-auth'))).toContain(
      'session refactor-auth',
    );
    expect(plain(buildWelcomeBanner('deep', 'gemini-3.5-flash'))).toContain('session new');
  });

  it('distinguishes the two modes', () => {
    expect(plain(buildWelcomeBanner('deep', 'gemini-3.5-flash'))).toContain('Umbra · Deep');
    expect(plain(buildWelcomeBanner('orchestrate', 'gemini-3.5-flash'))).toContain(
      'Umbra · Orchestrator',
    );
  });
});
