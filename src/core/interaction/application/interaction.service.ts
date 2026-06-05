import { LoggerPort } from '../domain/logger.port';
import { SpinnerPort, TaskIndicator, TaskSuccessMetadata } from '../domain/spinner.port';
import { ChalkLoggerAdapter } from '../infrastructure/chalk-logger.adapter';
import { OraSpinnerAdapter } from '../infrastructure/ora-spinner.adapter';

/**
 * Service to orchestrate rich and beautiful terminal interactions.
 * Built with DDD principles to decouple the domain from chalk/ora dependencies.
 *
 * @note This class does NOT use `@Injectable()`. It is always instantiated directly
 * with `new InteractionService()` — it never passes through the NestJS IoC container.
 * Adding `@Injectable()` pulls in `@nestjs/common` → `reflect-metadata` which crashes
 * the CLI (`ts-node`) because no entry point imports `reflect-metadata` first.
 */
export class InteractionService {
  private readonly logger: LoggerPort;
  private readonly spinner: SpinnerPort;
  private currentTask: TaskIndicator | null = null;

  constructor() {
    // We instantiate the default Chalk and Ora adapters.
    // In strict dependency injection, these could be provided by inversion of control,
    // but for our NestJS AI Agent library, we use these as standard defaults.
    this.logger = new ChalkLoggerAdapter();
    this.spinner = new OraSpinnerAdapter();
  }

  /**
   * Helper that acts as a middleware to pause spinners, run the log, and resume.
   */
  private runSpinnerAware(logFn: () => void): void {
    const isSpinning = this.currentTask?.isSpinning() ?? false;
    if (isSpinning) {
      this.currentTask!.pause();
    }
    logFn();
    if (isSpinning) {
      this.currentTask!.resume();
    }
  }

  /**
   * Logs an informational message.
   */
  logInfo(message: string): void {
    this.runSpinnerAware(() => this.logger.info(message));
  }

  /**
   * Logs a success highlighting.
   */
  logSuccess(message: string): void {
    this.runSpinnerAware(() => this.logger.success(message));
  }

  /**
   * Logs a warning.
   */
  logWarning(message: string): void {
    this.runSpinnerAware(() => this.logger.warn(message));
  }

  /**
   * Logs an error message, optionally with a stack trace or additional context.
   */
  logError(message: string, trace?: string): void {
    this.runSpinnerAware(() => this.logger.error(message, trace));
  }

  /**
   * Logs a debug trace, mostly for development or verbose runs.
   */
  logDebug(message: string): void {
    this.runSpinnerAware(() => this.logger.debug(message));
  }

  /**
   * Starts a visual task indicator (spinner) in the terminal.
   * @param text The action or task that is currently starting.
   * @returns A task indicator object to update, succeed, or fail the visual spinner.
   */
  startTask(text: string): TaskIndicator {
    // Stop any existing task properly before starting a new one
    if (this.currentTask && this.currentTask.isSpinning()) {
      this.currentTask.stop();
    }
    
    this.currentTask = this.spinner.startTask(text);

    // Bind original methods to intercept completion boundaries
    const originalSucceed = this.currentTask.succeed.bind(this.currentTask);
    const originalFail = this.currentTask.fail.bind(this.currentTask);
    const originalStop = this.currentTask.stop.bind(this.currentTask);

    this.currentTask.succeed = (msg?: string, metadata?: TaskSuccessMetadata) => {
      originalSucceed(msg, metadata);
      this.currentTask = null;
    };

    this.currentTask.fail = (msg?: string) => {
      originalFail(msg);
      this.currentTask = null;
    };

    this.currentTask.stop = () => {
      originalStop();
      this.currentTask = null;
    };

    return this.currentTask;
  }
}
