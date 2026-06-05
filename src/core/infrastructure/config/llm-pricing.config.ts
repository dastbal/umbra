import { PricingRegistry } from '../../domain/interfaces/pricing-registry';
import { Pricing } from '../../domain/types/pricing';
import { Money } from '../../domain/value-objects/money';
import * as fs from 'fs';
import * as path from 'path';

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
  private pricingData: Record<string, { inputMillion: number; outputMillion: number }> = {};

  constructor() {
    this.loadPricing();
  }

  private loadPricing(): void {
    try {
      const configPath = path.resolve(process.cwd(), 'llm-pricing.json');
      if (fs.existsSync(configPath)) {
        const fileContent = fs.readFileSync(configPath, 'utf8');
        this.pricingData = JSON.parse(fileContent);
      } else {
        console.warn(`${this.tag} Pricing file not found at ${configPath}. Using empty default pricing.`);
      }
    } catch (error) {
      if (error instanceof Error) {
        console.error(`${this.tag} Failed to load LLM pricing: ${error.message}`);
      }
    }
  }

  /**
   * Translates the price-per-million JSON into the Pricing domain object.
   */
  getPricingForModel(modelName: string): Pricing | undefined {
    const raw = this.pricingData[modelName];
    if (!raw) return undefined;

    return {
      modelName,
      // Convert million-token price to single-token price for precise multiplication
      promptTokenCost: new Money(raw.inputMillion / 1_000_000, 'USD'),
      completionTokenCost: new Money(raw.outputMillion / 1_000_000, 'USD'),
    };
  }
}
