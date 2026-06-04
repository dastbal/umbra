/**
 * Represents a running task indicator in the terminal.
 */
import { TokenUsage } from "../../domain/value-objects/token-usage";
import { Money } from "../../domain/value-objects/money";

export interface TaskSuccessMetadata {
  tokens?: TokenUsage;
  cost?: Money;
}
export interface TaskIndicator {
  /** Updates the text of the current task */
  update(text: string): void;
  
  /** Completes the task successfully with an optional specific message */
  succeed(text?: string, metadata?: TaskSuccessMetadata): void;
  
  /** Fails the task with an optional specific error message */
  fail(text?: string): void;
  
  /** Stops the task indicator permanently */
  stop(): void;

  /** Temporarily pauses the visual spinner (e.g. to print a log clean) */
  pause(): void;

  /** Resumes the visual spinner after being paused */
  resume(): void;

  /** Checks if the spinner is currently active */
  isSpinning(): boolean;
}

/**
 * Interface to manage task spinner factories.
 * Allows decoupling from specific libraries like 'ora'.
 */
export interface SpinnerPort {
  /** Starts a new task indicator */
  startTask(text: string): TaskIndicator;
}
