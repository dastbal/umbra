import { Money } from '../../domain/value-objects/money';
import { TokenUsage } from '../../domain/value-objects/token-usage';
import { PricingRegistry } from '../../domain/interfaces/pricing-registry';

/**
 * @note No `@Injectable()` — this service is instantiated directly with `new`
 * in the CLI graph pipeline. Adding NestJS decorators pulls in reflect-metadata
 * which crashes ts-node before the CLI boots.
 */
export class CostTrackerService {
    constructor(private readonly pricingRegistry: PricingRegistry) {}

    /**
     * Calculates the cost of a given token usage for a specific model.
     * @param modelName The name of the model.
     * @param usage The token usage details (prompt tokens and completion tokens).
     * @returns The calculated cost as a Money value object.
     */
    calculateCost(modelName: string, usage: TokenUsage): Money {
        const pricing = this.pricingRegistry.getPricingForModel(modelName);

        if (!pricing) {
            throw new Error(`Pricing not found for model: ${modelName}`);
        }

        const promptCost = pricing.promptTokenCost.multiply(usage.promptTokens);
        const completionCost = pricing.completionTokenCost.multiply(usage.completionTokens);

        return promptCost.add(completionCost);
    }
}
