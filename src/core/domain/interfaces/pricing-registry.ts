import { Pricing } from '../types/pricing';

export interface PricingRegistry {
    getPricingForModel(modelName: string): Pricing | undefined;
}
