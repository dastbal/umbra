// src/core/agent/domain/value-objects/model-profile.vo.ts

import { ValueObject } from '../../../shared/domain/value-object';

/**
 * Represents the profile of a language model used by an agent.
 * This is an immutable value object.
 */
export class ModelProfile extends ValueObject {
  public readonly supervisor: string;
  public readonly researcher: string;
  public readonly coder: string;
  public readonly verifier: string;

  constructor(supervisor: string, researcher: string, coder: string, verifier: string) {
    super();
    // Basic validation
    if (!supervisor || !researcher || !coder || !verifier) {
      throw new Error('All model profile roles must be specified.');
    }
    this.supervisor = supervisor;
    this.researcher = researcher;
    this.coder = coder;
    this.verifier = verifier;
  }

  equals(other: ModelProfile): boolean {
    return (
      this.supervisor === other.supervisor &&
      this.researcher === other.researcher &&
      this.coder === other.coder &&
      this.verifier === other.verifier
    );
  }
}
