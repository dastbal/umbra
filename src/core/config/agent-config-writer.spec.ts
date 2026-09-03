import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { agentPath } from './agent-directory';
import { setConfiguredEmbeddingsProvider } from './agent-config-writer';

describe('setConfiguredEmbeddingsProvider', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-config-writer-'));
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('persists only the selected provider and preserves unrelated raw settings', () => {
    const configPath = agentPath(rootDir, 'agent.config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, '{\n  "models": { "coder": "gemini-2.5-pro" },\n  "rag": {}\n}\n');

    const result = setConfiguredEmbeddingsProvider(rootDir, 'vertex');

    expect(result).toEqual({ path: configPath, saved: true });
    expect(fs.readFileSync(configPath, 'utf8')).toBe(
      '{\n  "models": {\n    "coder": "gemini-2.5-pro"\n  },\n  "rag": {\n    "embeddings": "vertex"\n  }\n}\n',
    );
  });

  it('does not overwrite an invalid local policy', () => {
    const configPath = agentPath(rootDir, 'agent.config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, '{ invalid json');

    const result = setConfiguredEmbeddingsProvider(rootDir, 'ollama');

    expect(result.saved).toBe(false);
    expect(fs.readFileSync(configPath, 'utf8')).toBe('{ invalid json');
  });
});
