// src/core/agent/domain/value-objects/agent-type.vo.ts

import { ValueObject } from '../../../shared/domain/value-object';

/**
 * Represents the type of an agent (e.g., Researcher, Coder, Verifier).
 * This is an immutable value object.
 */
export class AgentType extends ValueObject {
  public readonly type: string;

  constructor(type: string) {
    super();
    // Basic validation: ensure type is not empty and is a known type
    if (!type || !['researcher', 'coder', 'verifier', 'orchestrator', 'simple'].includes(type.toLowerCase())) {
      throw new Error('Invalid agent type provided.');
    }
    this.type = type.toLowerCase();
  }

  // Value objects should be comparable
  equals(other: AgentType): boolean {
    return this.type === other.type;
  }

  // Add any other methods relevant to agent types, e.g., checking permissions
  isWriter(): boolean {
    return this.type === 'coder';
  }

  isReadOnly(): boolean {
    return !this.isWriter();
  }
}
