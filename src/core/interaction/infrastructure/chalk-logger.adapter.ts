import { LoggerPort } from '../domain/logger.port';
import chalk from 'chalk';

/**
 * Chalk-based implementation of the LoggerPort.
 * Provides colorful and beautifully formatted terminal output.
 */
export class ChalkLoggerAdapter implements LoggerPort {
  info(message: string): void {
    console.log(chalk.blue('ℹ'), chalk.whiteBright(message));
  }

  success(message: string): void {
    console.log(chalk.green('✔'), chalk.greenBright(message));
  }

  warn(message: string): void {
    console.log(chalk.yellow('⚠'), chalk.yellowBright(message));
  }

  error(message: string, trace?: string): void {
    console.log(chalk.red('✖'), chalk.redBright.bold(message));
    if (trace) {
      console.log(chalk.red.dim(trace));
    }
  }

  debug(message: string): void {
    console.log(chalk.gray('⚙'), chalk.gray(message));
  }
}
