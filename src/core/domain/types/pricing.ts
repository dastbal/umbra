import { Money } from '../value-objects/money';

export type Pricing = {
    modelName: string;
    promptTokenCost: Money;
    completionTokenCost: Money;
};
