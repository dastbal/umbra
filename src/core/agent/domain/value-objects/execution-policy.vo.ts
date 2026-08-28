// src/core/agent/domain/value-objects/execution-policy.vo.ts

import { ValueObject } from '../../../shared/domain/value-object';

/**
 * Represents the execution policy for an agent, defining its operational constraints.
 * This is an immutable value object.
 */
export class ExecutionPolicy extends ValueObject {
  public readonly maxRetries: number;
  public readonly maxDelegationDepth: number;
  public readonly singleWriter: boolean;
  public readonly autoApproveSafeEdits: boolean;
  public readonly requireApprovalForExternalActions: boolean;

  constructor(
    maxRetries: number,
    maxDelegationDepth: number,
    singleWriter: boolean,
    autoApproveSafeEdits: boolean,
    requireApprovalForExternalActions: boolean,
  ) {
    super();
    if (maxRetries < 0 || maxDelegationDepth < 0) {
      throw new Error('Max retries and delegation depth cannot be negative.');
    }
    this.maxRetries = maxRetries;
    this.maxDelegationDepth = maxDelegationDepth;
    this.singleWriter = singleWriter;
    this.autoApproveSafeEdits = autoApproveSafeEdits;
    this.requireApprovalForExternalActions = requireApprovalForExternalActions;
  }

  equals(other: ExecutionPolicy): boolean {
    return (
      this.maxRetries === other.maxRetries &&
      this.maxDelegationDepth === other.maxDelegationDepth &&
      this.singleWriter === other.singleWriter &&
      this.autoApproveSafeEdits === other.autoApproveSafeEdits &&
      this.requireApprovalForExternalActions === other.requireApprovalForExternalActions
    );
  }
}
