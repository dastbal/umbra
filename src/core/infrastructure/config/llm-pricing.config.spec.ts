import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LlmPricingConfig } from './llm-pricing.config';
import { DEFAULT_LLM_PRICING } from './default-pricing';

describe('LlmPricingConfig', () => {
  let cwd: string;
  let cwdSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'pricing-'));
    cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(cwd);
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    warnSpy.mockRestore();
    rmSync(cwd, { recursive: true, force: true });
  });

  it('prices packaged models with no llm-pricing.json present', () => {
    const pricing = new LlmPricingConfig().getPricingForModel('gemini-2.5-flash-lite');
    expect(pricing).toBeDefined();
    // 0.10 USD per million prompt tokens, expressed per single token.
    expect(pricing!.promptTokenCost.amount).toBeCloseTo(0.1 / 1_000_000, 12);
    expect(pricing!.completionTokenCost.amount).toBeCloseTo(0.4 / 1_000_000, 12);
  });

  it('prices every packaged model, so cost is never silently zero', () => {
    const config = new LlmPricingConfig();
    for (const modelName of Object.keys(DEFAULT_LLM_PRICING)) {
      expect(config.getPricingForModel(modelName)).toBeDefined();
    }
  });

  it('ships the published global Vertex prices for enabled Claude models', () => {
    const config = new LlmPricingConfig();

    const haiku = config.getPricingForModel('claude-haiku-4-5');
    expect(haiku!.promptTokenCost.amount).toBeCloseTo(1 / 1_000_000, 12);
    expect(haiku!.completionTokenCost.amount).toBeCloseTo(5 / 1_000_000, 12);

    const sonnet = config.getPricingForModel('claude-sonnet-5');
    expect(sonnet!.promptTokenCost.amount).toBeCloseTo(2 / 1_000_000, 12);
    expect(sonnet!.completionTokenCost.amount).toBeCloseTo(10 / 1_000_000, 12);

    const opus = config.getPricingForModel('claude-opus-5');
    expect(opus!.promptTokenCost.amount).toBeCloseTo(5 / 1_000_000, 12);
    expect(opus!.completionTokenCost.amount).toBeCloseTo(25 / 1_000_000, 12);

    expect(config.getPricingForModel('vertex-anthropic:claude-haiku-4-5@20251001'))
      .toEqual(expect.objectContaining({
        modelName: 'vertex-anthropic:claude-haiku-4-5@20251001',
      }));
  });

  it('lets a project-local file override one model without dropping the rest', () => {
    writeFileSync(
      join(cwd, 'llm-pricing.json'),
      JSON.stringify({ 'gemini-2.5-flash-lite': { inputMillion: 9, outputMillion: 9 } }),
      'utf8',
    );

    const config = new LlmPricingConfig();
    expect(config.getPricingForModel('gemini-2.5-flash-lite')!.promptTokenCost.amount)
      .toBeCloseTo(9 / 1_000_000, 12);
    expect(config.getPricingForModel('gemini-2.5-pro')).toBeDefined();
  });

  it('keeps the packaged defaults when the override file is malformed', () => {
    writeFileSync(join(cwd, 'llm-pricing.json'), '{ not json', 'utf8');
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(new LlmPricingConfig().getPricingForModel('gemini-2.5-pro')).toBeDefined();
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('warns once for an unknown model instead of returning zero in silence', () => {
    const config = new LlmPricingConfig();
    expect(config.getPricingForModel('no-such-model')).toBeUndefined();
    expect(config.getPricingForModel('no-such-model')).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
