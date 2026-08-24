import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { exec } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import { log } from "./utils/logger";
import { buildAdrIndex, formatAdrIndex } from "./adr-index";

const execAsync = promisify(exec);

export const listFilesTool = tool(
  async ({ dirPath }) => {
    try {
      const rootDir = process.cwd();
      const targetDir = path.resolve(rootDir, dirPath || ".");
      if (!fs.existsSync(targetDir)) return `❌ Directory not found: ${dirPath}`;
      const files = fs.readdirSync(targetDir, { withFileTypes: true });
      const list = files.map((f) => `${f.isDirectory() ? "📂" : "📄"} ${f.name}`).join("\n");
      log.sys(`Listed directory: ${dirPath}`);
      return `Contents of ${dirPath}:\n${list}`;
    } catch (e: any) {
      return `❌ Error listing directory: ${e.message}`;
    }
  },
  {
    name: "list_files",
    description: "Lists files and directories in a specific path.",
    schema: z.object({ dirPath: z.string().optional().default(".") }),
  },
);

/**
 * Lists compact ADR metadata so an agent can choose one decision record to read.
 *
 * This avoids injecting or repeatedly reading the full ADR history during
 * ordinary coding tasks. The persistent catalog remains local to `.agent/`.
 */
export const listAdrsTool = tool(
  async ({ refresh }) => {
    try {
      const index = buildAdrIndex(process.cwd(), refresh);
      log.sys(`ADR catalog ${index.status}: ${index.entries.length} decisions`);
      return formatAdrIndex(index);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return `âŒ Error indexing ADR files: ${message}`;
    }
  },
  {
    name: "list_adrs",
    description:
      "Lists ADR paths, titles, status, and compact context without returning ADR bodies. " +
      "Use only when architecture history is relevant; then read the selected ADR with safe_read_file.",
    schema: z.object({
      refresh: z.boolean().optional().default(false).describe("Rebuild the local ADR catalog."),
    }),
  },
);

export const executeCommandTool = tool(
  async ({ command }) => {
    const rootDir = process.cwd();
    log.tool(`🚀 Executing command: ${command}`);
    const forbiddenPatterns = [/rm\s+-rf\s+\//, /mkfs/, /dd\s+if/];
    if (forbiddenPatterns.some((pattern) => pattern.test(command))) return "❌ Error: Command blocked for security reasons.";
    try {
      const { stdout, stderr } = await execAsync(command, { cwd: rootDir, timeout: 30000 });
      log.tool("✅ Command executed successfully.");
      return `✅ SUCCESS: Command executed.\nSTDOUT: ${stdout}\nSTDERR: ${stderr}`;
    } catch (error: any) {
      log.error(`Command failed or timed out: ${command}`);
      const output = error.stdout || error.stderr || error.message;
      return `❌ ERROR: Command failed.\n${output}`;
    }
  },
  {
    name: "execute_command",
    description: "Executes a terminal command (HITL protected).",
    schema: z.object({ command: z.string().describe("The full command to run.") }),
  },
);
