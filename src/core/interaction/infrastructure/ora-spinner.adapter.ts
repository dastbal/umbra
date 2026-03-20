import { SpinnerPort, TaskIndicator } from '../domain/spinner.port';
import ora from 'ora';
import chalk from 'chalk';

/**
 * Task indicator wrapper for Ora.
 */
class OraTaskIndicator implements TaskIndicator {
  constructor(private readonly spinner: ora.Ora) {}

  update(text: string): void {
    this.spinner.text = chalk.cyan(text);
  }

  succeed(text?: string): void {
    this.spinner.succeed(text ? chalk.greenBright(text) : undefined);
  }

  fail(text?: string): void {
    this.spinner.fail(text ? chalk.redBright.bold(text) : undefined);
  }

  stop(): void {
    this.spinner.stop();
  }

  pause(): void {
    if (this.spinner.isSpinning) {
      this.spinner.clear();
      this.spinner.stop();
    }
  }

  resume(): void {
    if (!this.spinner.isSpinning) {
      this.spinner.start();
    }
  }

  isSpinning(): boolean {
    return this.spinner.isSpinning;
  }
}

/**
 * Ora-based implementation for creating terminal spinners.
 */
export class OraSpinnerAdapter implements SpinnerPort {
  startTask(text: string): TaskIndicator {
    const spinner = ora({
      text: chalk.cyan(text),
      color: 'cyan',
    }).start();

    return new OraTaskIndicator(spinner);
  }
}
