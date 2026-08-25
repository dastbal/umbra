import { tool } from "@langchain/core/tools";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { IndexerService } from "../rag/indexer";
import { log } from "./utils/logger";
import { resolveWorkspacePath } from '../security';
import { authorizeFileAction, evaluateFileAction, formatAuthorizationFailure } from './utils/authorize';
import { requestApproval, rethrowIfSuspension } from './utils/approval';
import { wrapUntrustedFileContent, stripUntrustedFrame } from './utils/untrusted-content';

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
      const evaluation = evaluateFileAction('write_file', rootDir, filePath);
      if (evaluation.decision === 'deny') return formatAuthorizationFailure(evaluation);
      // Everything below is the side effect: it must stay after the approval
      // gate, because a resume re-runs this body from the top.
      if (
        evaluation.decision === 'require_approval' &&
        !requestApproval('safe_write_file', { file_path: filePath, bytes: content.length }, evaluation.reason)
      ) {
        log.tool(`Write rejected by operator: ${filePath}`);
        return `❌ REJECTED: The operator did not approve writing ${filePath}. Do not retry; ask what to do next.`;
      }
      const targetPath = resolveWorkspacePath(rootDir, filePath);
      if (!targetPath) return '❌ DENIED: The target cannot be resolved safely.';
      const exists = fs.existsSync(targetPath);
      const dir = path.dirname(targetPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      createBackup(filePath);
      // A model that read this file may echo the read frame back as content.
      // Stripping it here is what actually prevents the corruption; the notice
      // inside the frame only asks.
      const sanitized = stripUntrustedFrame(content);
      if (sanitized !== content) {
        log.tool(`Stripped read-frame markers echoed back into ${filePath}.`);
      }
      fs.writeFileSync(targetPath, sanitized, "utf-8");
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
      // The approval interrupt travels as a thrown value; swallowing it here
      // would silently write the file without ever asking anyone.
      rethrowIfSuspension(error);
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
      const authorization = authorizeFileAction('read_file', rootDir, filePath);
      if (authorization) return authorization;
      const targetPath = resolveWorkspacePath(rootDir, filePath);
      if (!targetPath) return '❌ DENIED: The target cannot be resolved safely.';
      if (!fs.existsSync(targetPath)) return `❌ File not found: ${filePath}`;
      const content = fs.readFileSync(targetPath, "utf-8");
      log.sys(`File read successfully: ${filePath}`);
      return wrapUntrustedFileContent(filePath, content);
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
    const evaluation = evaluateFileAction('delete_file', rootDir, filePath);
    if (evaluation.decision === 'deny') return formatAuthorizationFailure(evaluation);
    // The unlink below must stay after the gate: a resume re-runs this body.
    if (
      evaluation.decision === 'require_approval' &&
      !requestApproval('delete_file', { file_path: filePath }, evaluation.reason)
    ) {
      log.tool(`Delete rejected by operator: ${filePath}`);
      return `❌ REJECTED: The operator did not approve deleting ${filePath}. Do not retry; ask what to do next.`;
    }
    const fullPath = resolveWorkspacePath(rootDir, filePath);
    if (!fullPath) return '❌ DENIED: The target cannot be resolved safely.';
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
