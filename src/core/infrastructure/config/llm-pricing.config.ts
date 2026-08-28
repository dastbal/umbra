import { PricingRegistry } from '../../domain/interfaces/pricing-registry';
import { Pricing } from '../../domain/types/pricing';
import { Money } from '../../domain/value-objects/money';
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_LLM_PRICING, ModelPricingEntry } from './default-pricing';

/**
 * Infrastructure service that loads LLM pricing from a local JSON configuration.
 * Implements the new PricingRegistry interface.
 *
 * @note No `@Injectable()` \u2014 this class is instantiated directly with `new` in the
 * CLI graph pipeline. NestJS decorators pull in reflect-metadata which crashes
 * ts-node before the CLI boots. Plain console.warn/error replace NestJS Logger.
 */
export class LlmPricingConfig implements PricingRegistry {
  private readonly tag = '[LlmPricingConfig]';
  private pricingData: Record<string, ModelPricingEntry> = {};
  /** Models already reported as unpriced, so the warning is not repeated per call. */
  private readonly unpricedModels = new Set<string>();

  constructor() {
    this.loadPricing();
  }

  /**
   * Loads the pricing table: packaged defaults first, project overrides on top.
   *
   * The project-local `llm-pricing.json` is an *override*, not the only source.
   * When it was the only source, a clone without that file (it is gitignored,
   * and npm does not ship it) priced every model at zero without failing.
   */
  private loadPricing(): void {
    this.pricingData = { ...DEFAULT_LLM_PRICING };
    try {
      const configPath = path.resolve(process.cwd(), 'llm-pricing.json');
      if (!fs.existsSync(configPath)) return;
      const fileContent = fs.readFileSync(configPath, 'utf8');
      const overrides = JSON.parse(fileContent) as Record<string, ModelPricingEntry>;
      this.pricingData = { ...this.pricingData, ...overrides };
    } catch (error) {
      // A malformed override must not silently discard the packaged defaults,
      // which stay in place because they were assigned before parsing.
      if (error instanceof Error) {
        console.error(`${this.tag} Failed to load LLM pricing overrides: ${error.message}`);
      }
    }
  }

  /**
   * Translates the price-per-million JSON into the Pricing domain object.
   */
  getPricingForModel(modelName: string): Pricing | undefined {
    const providerNeutralName = modelName.startsWith('vertex-anthropic:')
      ? modelName.slice('vertex-anthropic:'.length)
      : modelName;
    const stablePricingName = providerNeutralName.replace(/@\d{8}$/, '');
    const raw = this.pricingData[modelName]
      ?? this.pricingData[providerNeutralName]
      ?? this.pricingData[stablePricingName];
    if (!raw) {
      // Warn once per model: this is called for every usage report, and a silent
      // `undefined` here is exactly how cost tracking used to report zero.
      if (!this.unpricedModels.has(modelName)) {
        this.unpricedModels.add(modelName);
        console.warn(`${this.tag} No pricing for '${modelName}'. Cost will be reported as zero for it.`);
      }
      return undefined;
    }

    return {
      modelName,
      // Convert million-token price to single-token price for precise multiplication
      promptTokenCost: new Money(raw.inputMillion / 1_000_000, 'USD'),
      completionTokenCost: new Money(raw.outputMillion / 1_000_000, 'USD'),
    };
  }
}
