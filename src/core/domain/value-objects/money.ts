import { ValueObject } from './value-object';

export class Money extends ValueObject {
    constructor(private readonly _amount: number, public readonly currency: string) {
        super();
    }

    get amount(): number {
        return this._amount;
    }

    add(other: Money): Money {
        if (this.currency !== other.currency) {
            throw new Error('Cannot add money of different currencies');
        }
        return new Money(this._amount + other.amount, this.currency);
    }

    multiply(factor: number): Money {
        return new Money(this._amount * factor, this.currency);
    }

    format(): string {
        return `${this.currency} ${this._amount.toFixed(2)}`; // Example formatting
    }
}
