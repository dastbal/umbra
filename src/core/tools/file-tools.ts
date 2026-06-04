import { tool } from "@langchain/core/tools";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { IndexerService } from "../rag/indexer";
import { log } from "./utils/logger";

let indexTimer: NodeJS.Timeout | null = null;

const createBackup = (filePath: string) => {
  log.debug(`Starting backup process for file: ${filePath}`);
  const rootDir = process.cwd();
  const backupDir = path.join(rootDir, ".agent", "backups");
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
  const realPath = path.resolve(rootDir, filePath);
  if (fs.existsSync(realPath)) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = path.basename(realPath);
    const backupPath = path.join(backupDir, `${timestamp}_${filename}.bak`);
    fs.copyFileSync(realPath, backupPath);
    log.sys(`Backup created for ${filePath} at ${backupPath}`);
  }
};

export const safeWriteFileTool = tool(
  async ({ file_path, content }) => {
    const filePath = file_path;
    log.debug(`safe_write_file called with filePath: ${filePath}`);
    try {
      const rootDir = process.cwd();
      const targetPath = path.resolve(rootDir, filePath);
      if (!targetPath.startsWith(rootDir)) return "❌ Error: Access denied. Cannot write outside the project root.";
      const exists = fs.existsSync(targetPath);
      const dir = path.dirname(targetPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      createBackup(filePath); 
      fs.writeFileSync(targetPath, content, "utf-8");
      const action = exists ? "modified" : "created";
      log.sys(`File ${action} on REAL DISK: ${filePath}`);
      
      // DEBOUNCED INDEXING: Prevent parallel indexing locks when multiple files are written rapidly
      if (indexTimer) clearTimeout(indexTimer);
      indexTimer = setTimeout(() => {
        IndexerService.silent = true; // suppress output during streaming sessions
        const indexer = new IndexerService();
        indexer.indexProject().catch((err) => log.error(`Failed to re-index after write: ${err.message}`));
      }, 3000);

      return `✅ SUCCESS: File ${action} at ${filePath}. [METADATA: {"path": "${filePath}", "action": "${action}"}]`;
    } catch (error: any) {
      log.error(`Failed to write file ${filePath}: ${error.message}`);
      return `❌ Error writing file: ${error.message}`;
    }
  },
  {
    name: "safe_write_file",
    description: "WRITES code to the REAL local disk. Returns if it was created or modified.",
    schema: z.object({
      file_path: z.string().describe("Relative path (e.g., src/app.service.ts)"),
      content: z.string().describe("Full file content"),
    }),
  },
);

export const safeReadFileTool = tool(
  async ({ file_path }) => {
    const filePath = file_path;
    log.debug(`safe_read_file called with filePath: ${filePath}`);
    try {
      const rootDir = process.cwd();
      const targetPath = path.resolve(rootDir, filePath);
      if (!fs.existsSync(targetPath)) return `❌ File not found: ${filePath}`;
      if (!targetPath.startsWith(rootDir)) return "❌ Error: Access denied. Cannot read outside the project root.";
      const content = fs.readFileSync(targetPath, "utf-8");
      log.sys(`File read successfully: ${filePath}`);
      return content;
    } catch (e: any) {
      log.error(`Failed to read file ${filePath}: ${e.message}`);
      return `❌ Error reading file: ${e.message}`;
    }
  },
  {
    name: "safe_read_file",
    description: "READS code from the REAL local disk.",
    schema: z.object({ file_path: z.string().describe("The relative path to the file to read (e.g., README.md, src/app.ts)") }),
  },
);

export const deleteFileTool = tool(
  async ({ file_path }) => {
    const filePath = file_path;
    const rootDir = process.cwd();
    const fullPath = path.resolve(rootDir, filePath);
    if (!fullPath.startsWith(rootDir)) return "❌ Error: Access denied. Cannot delete files outside the project root.";
    if (!fs.existsSync(fullPath)) return `❌ ERROR: File ${filePath} does not exist.`;
    fs.unlinkSync(fullPath);
    log.tool(`🗑️ File deleted: ${filePath}`);
    return `✅ SUCCESS: File ${filePath} has been deleted.`;
  },
  {
    name: "delete_file",
    description: "Deletes a file at the specified path.",
    schema: z.object({ file_path: z.string().describe("The relative path to the file to delete.") }),
  },
);
