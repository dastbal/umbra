import { ValueObject } from './value-object';

export class TokenUsage extends ValueObject {
    constructor(public readonly promptTokens: number, public readonly completionTokens: number) {
        super();
    }

    add(other: TokenUsage): TokenUsage {
        return new TokenUsage(this.promptTokens + other.promptTokens, this.completionTokens + other.completionTokens);
    }
}
