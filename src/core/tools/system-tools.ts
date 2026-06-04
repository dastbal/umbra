import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { exec } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import { log } from "./utils/logger";

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
