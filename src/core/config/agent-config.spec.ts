import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureAgentConfig, loadAgentConfig, parseAgentConfig } from './agent-config';

describe('parseAgentConfig', () => {
  it('applies safe defaults for an empty configuration', () => {
    const config = parseAgentConfig({});

    expect(config.models.researcher).toBe('gemini-2.5-flash-lite');
    expect(config.limits.maxRetries).toBe(2);
    expect(config.limits.maxDelegationDepth).toBe(1);
    expect(config.permissions.singleWriter).toBe(true);
  });

  it('accepts role-specific model profiles and limits', () => {
    const config = parseAgentConfig({
      models: {
        coder: 'gemini-2.5-pro',
        verifier: 'gemini-2.5-flash-lite',
      },
      limits: {
        maxRetries: 1,
      },
    });

    expect(config.models.coder).toBe('gemini-2.5-pro');
    expect(config.models.verifier).toBe('gemini-2.5-flash-lite');
    expect(config.limits.maxRetries).toBe(1);
  });

  it('rejects unsafe retry and delegation limits', () => {
    expect(() => parseAgentConfig({ limits: { maxRetries: 3 } })).toThrow();
    expect(() =>
      parseAgentConfig({ limits: { maxDelegationDepth: 2 } }),
    ).toThrow();
  });

  it('loads a project-local config and keeps a missing file on safe defaults', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'nestjs-agent-config-'));
    try {
      expect(loadAgentConfig(rootDir).permissions.singleWriter).toBe(true);

      const configDir = join(rootDir, '.agent');
      mkdirSync(configDir);
      writeFileSync(
        join(configDir, 'agent.config.json'),
        JSON.stringify({ models: { coder: 'ollama:gemma4' } }),
        'utf8',
      );

      expect(loadAgentConfig(rootDir).models.coder).toBe('ollama:gemma4');
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('fails loudly when the project config contains invalid JSON', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'nestjs-agent-config-invalid-'));
    try {
      const configDir = join(rootDir, '.agent');
      mkdirSync(configDir);
      writeFileSync(join(configDir, 'agent.config.json'), '{invalid', 'utf8');

      expect(() => loadAgentConfig(rootDir)).toThrow(/agent\.config\.json/);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('initializes a missing config without overwriting an existing one', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'nestjs-agent-config-init-'));
    try {
      const first = ensureAgentConfig(rootDir);
      expect(first.created).toBe(true);
      expect(loadAgentConfig(rootDir).limits.maxRetries).toBe(2);

      const second = ensureAgentConfig(rootDir);
      expect(second.created).toBe(false);
      expect(second.path).toBe(first.path);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
