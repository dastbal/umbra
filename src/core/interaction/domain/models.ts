/**
 * Defines the log levels supported by the Interaction Module.
 */
export enum LogLevel {
  DEBUG = 'debug',
  INFO = 'info',
  WARNING = 'warn',
  ERROR = 'error',
  SUCCESS = 'success',
}

/**
 * Configuration for the Interaction Module.
 */
export interface InteractionConfig {
  /** Whether explicitly enable/disable terminal colors. Default usually true. */
  enableColors?: boolean;
  
  /** Whether to enable active task spinners. */
  enableSpinners?: boolean;
}
