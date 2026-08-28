import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  configureLangSmith,
  getLangSmithConfigPath,
  hasLangSmithConfiguration,
} from './langsmith-config';

describe('LangSmith project configuration', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-langsmith-'));
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('writes tracing credentials in ignored Umbra state, not the project .env', () => {
    const result = configureLangSmith(rootDir, {
      apiKey: 'lsv2_pt_test-key',
      project: 'payments-agent',
    });

    expect(result.path).toBe(getLangSmithConfigPath(rootDir));
    expect(fs.existsSync(path.join(rootDir, '.env'))).toBe(false);
    expect(fs.readFileSync(result.path, 'utf8')).toContain('LANGSMITH_TRACING="true"');
    expect(fs.readFileSync(result.path, 'utf8')).toContain('LANGSMITH_PROJECT="payments-agent"');
    expect(hasLangSmithConfiguration(rootDir)).toBe(true);
  });

  it('supports an optional self-hosted endpoint', () => {
    const { path: configPath } = configureLangSmith(rootDir, {
      apiKey: 'lsv2_pt_test-key',
      project: 'payments-agent',
      endpoint: 'https://langsmith.example.test',
    });

    expect(fs.readFileSync(configPath, 'utf8')).toContain(
      'LANGSMITH_ENDPOINT="https://langsmith.example.test"',
    );
  });

  it('rejects an empty credential before creating a file', () => {
    expect(() => configureLangSmith(rootDir, { apiKey: ' ', project: 'agent' })).toThrow(
      'LangSmith API key is required',
    );
    expect(fs.existsSync(getLangSmithConfigPath(rootDir))).toBe(false);
  });

  it('never overwrites credentials that were already configured', () => {
    configureLangSmith(rootDir, { apiKey: 'first-key', project: 'agent' });

    expect(() => configureLangSmith(rootDir, { apiKey: 'second-key', project: 'agent' })).toThrow(
      'already exists',
    );
    expect(fs.readFileSync(getLangSmithConfigPath(rootDir), 'utf8')).toContain('first-key');
  });
});
