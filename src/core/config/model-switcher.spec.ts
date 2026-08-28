import { ModelSwitcher } from './model-switcher';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

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

describe('ModelSwitcher.getVertexClaudeModels', () => {
  it('offers only the enabled Claude presets through the Vertex transport', () => {
    const modelNames = ModelSwitcher.getVertexClaudeModels()
      .map((model) => model.name)
      .filter((name) => name.startsWith('vertex-anthropic:'));

    expect(modelNames).toEqual([
      'vertex-anthropic:claude-haiku-4-5@20251001',
      'vertex-anthropic:claude-sonnet-5',
      'vertex-anthropic:claude-opus-5',
    ]);
  });

  it('persists the Claude model and Google project in one env update', () => {
    const directory = mkdtempSync(join(tmpdir(), 'claude-vertex-env-'));
    const envPath = join(directory, '.env');
    writeFileSync(envPath, 'EXISTING=value\nAGENT_MODEL=gemini-2.5-flash\n', 'utf8');

    try {
      expect(ModelSwitcher.saveClaudeVertexSelectionToEnv(
        'vertex-anthropic:claude-haiku-4-5@20251001',
        'blue-label-prod',
        envPath,
      )).toBe(true);

      expect(readFileSync(envPath, 'utf8')).toBe([
        'EXISTING=value',
        'AGENT_MODEL=vertex-anthropic:claude-haiku-4-5@20251001',
        'GOOGLE_CLOUD_PROJECT=blue-label-prod',
        '',
      ].join('\n'));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
