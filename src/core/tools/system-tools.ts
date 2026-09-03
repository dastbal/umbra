import { tool } from "@langchain/core/tools";
import { z } from "zod";
import * as fs from 'fs';
import * as path from 'path';
import { log } from "./utils/logger";
import { buildAdrIndex, formatAdrIndex } from "./adr-index";
import { AgentSecurityPolicy, resolveWorkspacePath } from '../security';
import { runtimeRoot } from '../config/runtime-root';

const securityPolicy = new AgentSecurityPolicy();

export const listFilesTool = tool(
  async ({ dirPath }) => {
    try {
      const rootDir = runtimeRoot();
      const evaluation = securityPolicy.evaluate({ kind: 'read_file', rootDir, targetPath: dirPath || '.' });
      if (evaluation.decision !== 'allow') return `❌ DENIED: ${evaluation.reason}`;
      const targetDir = path.resolve(rootDir, dirPath || ".");
      if (resolveWorkspacePath(rootDir, dirPath || '.') === undefined) return '❌ DENIED: The directory escapes the workspace.';
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
 * ordinary coding tasks. The persistent catalog remains local to `.umbra/`.
 */
export const listAdrsTool = tool(
  async ({ refresh }) => {
    try {
      const index = buildAdrIndex(runtimeRoot(), refresh);
      log.sys(`ADR catalog ${index.status}: ${index.entries.length} decisions`);
      return formatAdrIndex(index);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return `❌ Error indexing ADR files: ${message}`;
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
    void command;
    log.tool('Blocked arbitrary command execution.');
    return '❌ DENIED: Arbitrary shell commands are disabled. Use run_tests or run_integrity_check.';
  },
  {
    name: "execute_command",
    description: "Disabled. Use typed verification tools instead of arbitrary shell commands.",
    schema: z.object({ command: z.string().describe("The full command to run.") }),
  },
);
