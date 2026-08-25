// src/core/agent/domain/agent.interface.ts

/**
 * Represents the core contract for any agent.
 * This interface defines the fundamental operations an agent must support.
 */
export interface IAgent {
  /**
   * Executes the agent's primary task.
   * @param context - The execution context, potentially containing input and state.
   * @returns A promise that resolves with the result of the agent's execution.
   */
  execute(context: any): Promise<any>;
}

/**
 * Represents a specific type of agent, e.g., Researcher, Coder, Verifier.
 * This can be extended to include type-specific methods or properties.
 */
export interface ISpecializedAgent extends IAgent {
  // Add any methods or properties specific to specialized agents here.
  // For example:
  // research(query: string): Promise<ResearchOutput>;
  // code(plan: CodePlan): Promise<CodeResult>;
  // verify(code: CodeResult): Promise<VerificationResult>;
}
