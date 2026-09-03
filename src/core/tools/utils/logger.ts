import chalk from "chalk";
import { writeLine } from "../../observability/console-sink";

/**
 * Umbra's tool-facing diagnostic logger.
 *
 * The five levels and their vocabulary are unchanged; only the destination
 * moved. Every line now goes through `writeLine`, so `umbra mcp` can redirect
 * diagnostics to `stderr` and keep `stdout` reserved for JSON-RPC (ADR-024,
 * constraint 4) without touching any of the call sites.
 */
export const log = {
  ai: (msg: string) => writeLine(chalk.blue("🤖 [AI]: ") + msg),
  tool: (msg: string) => writeLine(chalk.yellow("🛠️  [TOOL]: ") + msg),
  sys: (msg: string) => writeLine(chalk.gray("⚙️  [SYS]: ") + msg),
  error: (msg: string) => writeLine(chalk.red("❌ [ERR]: ") + msg),
  debug: (msg: string) => writeLine(chalk.magenta("🐛 [DEBUG]: ") + msg),
};
