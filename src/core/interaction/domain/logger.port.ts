/**
 * Interface for logging messages.
 * We abstract the logger to decouple it from specific libraries (e.g., chalk).
 */
export interface LoggerPort {
  /** Logs an informational message */
  info(message: string): void;

  /** Logs a success message */
  success(message: string): void;

  /** Logs a warning message */
  warn(message: string): void;

  /** Logs an error message */
  error(message: string, trace?: string): void;

  /** Logs a debug message, usually hidden unless configured otherwise */
  debug(message: string): void;
}
