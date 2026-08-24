import { ModelSwitcher } from './model-switcher';

describe('ModelSwitcher.getVertexModels', () => {
  it('offers only supported stable Gemini presets in the interactive menu', () => {
    const modelNames = ModelSwitcher.getVertexModels()
      .map((model) => model.name)
      .filter((name) => name.startsWith('gemini-'));

    expect(modelNames).toEqual([
      'gemini-3.5-flash',
      'gemini-3.5-flash-lite',
      'gemini-3.1-flash-lite',
      'gemini-2.5-flash-lite',
      'gemini-2.5-flash',
      'gemini-2.5-pro',
    ]);
    expect(modelNames).not.toContain('gemini-3.1-pro');
  });
});
