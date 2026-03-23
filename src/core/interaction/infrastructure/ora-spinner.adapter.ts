import { SpinnerPort, TaskIndicator, TaskSuccessMetadata } from '../domain/spinner.port';
import { TokenUsage } from '../../domain/value-objects/token-usage';
import { Money } from '../../domain/value-objects/money';
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

  succeed(text?: string, metadata?: TaskSuccessMetadata): void {
    let output = text ? chalk.greenBright(text) : 'Task completed';
    if (metadata && metadata.tokens && metadata.cost) {
      const tokensInfo = chalk.gray(`[Tokens: ${metadata.tokens.promptTokens > 1000 ? (metadata.tokens.promptTokens/1000).toFixed(1) + 'k' : metadata.tokens.promptTokens} in / ${metadata.tokens.completionTokens > 1000 ? (metadata.tokens.completionTokens/1000).toFixed(1) + 'k' : metadata.tokens.completionTokens} out | `);
      const costInfo = chalk.yellow(`Cost: ${chalk.bold(metadata.cost.amount.toFixed(4))} USD]`);
      output = `${output} ${tokensInfo}${costInfo}`;
    }
    this.spinner.succeed(output);
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
