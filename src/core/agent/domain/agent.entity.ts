// src/core/agent/domain/agent.entity.ts

import { AgentType } from './value-objects/agent-type.vo';
import { ExecutionPolicy } from './value-objects/execution-policy.vo';
import { ModelProfile } from './value-objects/model-profile.vo';
import { IAgent } from './agent.interface'; // Assuming IAgent is defined in agent.interface.ts

/**
 * Represents an Agent entity, encapsulating its core properties and behavior.
 * This entity is central to the agent's identity and operational parameters.
 */
export class Agent {
  public readonly id: string;
  public readonly type: AgentType;
  public readonly modelProfile: ModelProfile;
  public readonly executionPolicy: ExecutionPolicy;
  public readonly skills: string[]; // List of available skills/tools

  constructor(
    id: string,
    type: AgentType,
    modelProfile: ModelProfile,
    executionPolicy: ExecutionPolicy,
    skills: string[] = [],
  ) {
    // Basic validation
    if (!id) {
      throw new Error('Agent ID cannot be empty.');
    }
    this.id = id;
    this.type = type;
    this.modelProfile = modelProfile;
    this.executionPolicy = executionPolicy;
    this.skills = skills;
  }

  // Example of a method that might be part of the Agent entity,
  // though complex logic should ideally be in Application Services.
  canExecuteTask(): boolean {
    // Example: Check if the agent has the necessary skills or permissions
    return this.skills.length > 0;
  }

  // Method to get the primary interface for execution, delegating to Application Layer
  // In a strict DDD, this might not be on the entity itself but orchestrated by an Application Service.
  // For now, we keep it simple and assume the entity can provide its execution interface.
  getExecutionInterface(): IAgent {
    // This would typically involve dependency injection or a factory
    // to return the correct implementation based on AgentType.
    // For demonstration, we'll return a placeholder.
    // In a real scenario, this might return an instance of a concrete agent class
    // from the Application or Infrastructure layer.
    console.warn('getExecutionInterface() is a placeholder. Actual implementation depends on Application Layer services.');
    // Placeholder: Return a dummy agent that logs its type
    return {
      execute: async (context: any) => {
        console.log(`Executing agent of type: ${this.type.type} with context:`, context);
        return { success: true, message: `Agent ${this.id} executed.` };
      },
    };
  }
}
