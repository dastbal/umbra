// src/core/shared/domain/value-object.ts

/**
 * Base class for domain value objects.
 *
 * A value object has no identity: two instances holding the same data are the
 * same value. Subclasses are therefore expected to be immutable — declare their
 * fields `readonly` and validate in the constructor, so an instance cannot
 * exist in an invalid state.
 *
 * This class deliberately carries no behaviour beyond the equality contract.
 * It exists so the domain layer has one place to state that contract, not to
 * share implementation.
 *
 * @example
 * ```ts
 * export class AgentType extends ValueObject {
 *   public readonly type: string;
 *
 *   constructor(type: string) {
 *     super();
 *     if (!type) throw new Error('Invalid agent type provided.');
 *     this.type = type.toLowerCase();
 *   }
 *
 *   equals(other: AgentType): boolean {
 *     return this.type === other.type;
 *   }
 * }
 * ```
 */
export abstract class ValueObject {
  /**
   * Compare this value object with another of the same kind.
   *
   * Implementations compare the data the value is made of, never a reference
   * or a generated identifier.
   *
   * @param other - The value object to compare against.
   * @returns `true` when both hold the same value.
   */
  public abstract equals(other: ValueObject): boolean;
}
