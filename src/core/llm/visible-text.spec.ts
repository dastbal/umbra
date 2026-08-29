import { readVisibleText } from './visible-text';

describe('readVisibleText', () => {
  it('passes plain string content through untouched', () => {
    expect(readVisibleText('Hola! ¿En qué puedo ayudarte?')).toBe('Hola! ¿En qué puedo ayudarte?');
  });

  it('hides a Gemini thought and keeps the answer that followed it', () => {
    // The live failure of 2026-08-28. The CLI read content[0] and printed the
    // model deliberating about its own CONVERSATION GATE, then glued the
    // greeting on with no separator.
    const chunk = [
      { thought: true, text: 'The lane is read, so the gate applies and I should answer briefly.' },
      { text: '¡Todo bien por aquí!' },
    ];

    expect(readVisibleText(chunk)).toBe('¡Todo bien por aquí!');
  });

  it.each(['thinking', 'redacted_thinking', 'reasoning'])(
    'hides a %s block, however the provider labels it',
    (type) => {
      expect(readVisibleText([{ type, text: 'private' }, { type: 'text', text: 'visible' }]))
        .toBe('visible');
    },
  );

  it('keeps every text block, not only the first', () => {
    // The same expression dropped everything past content[0], so a two-part
    // answer arrived truncated even with no reasoning involved.
    expect(readVisibleText([{ text: 'primera ' }, { text: 'y segunda' }]))
      .toBe('primera y segunda');
  });

  it('returns nothing for a chunk that carried only reasoning', () => {
    expect(readVisibleText([{ thought: true, text: 'deliberating' }])).toBe('');
  });

  it('shows a block it cannot classify rather than hiding it', () => {
    // Hiding an answer is worse than showing one oddly: an unknown shape is
    // more likely a new answer format than a new reasoning format.
    expect(readVisibleText([{ type: 'output_text', text: 'visible' }])).toBe('visible');
  });

  it('survives the shapes a stream actually produces', () => {
    expect(readVisibleText(undefined)).toBe('');
    expect(readVisibleText(null)).toBe('');
    expect(readVisibleText([])).toBe('');
    expect(readVisibleText([null, 42, { text: 'ok' }])).toBe('ok');
    expect(readVisibleText([{ type: 'tool_use', id: 'x' }])).toBe('');
  });
});
