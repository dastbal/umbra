import { tool } from "@langchain/core/tools";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { NestChunker } from "./ast/chunker";
import { AgentDB } from "../state/db";
import { log } from "./utils/logger";
import { authorizeFileAction } from "./utils/authorize";
import { wrapUntrustedFileContent } from "./utils/untrusted-content";
import { resolveWorkspacePath } from "../security";

/** The skeleton shape the chunker produces for a logic file. */
interface LogicSkeleton {
  imports?: string[];
  classes?: Array<{ name?: string; methods?: string[] }>;
}

/**
 * Renders a chunker skeleton as text for the model.
 *
 * `NestChunker.analyze` returns `skeleton` as an **object** because the file
 * registry persists it as JSON. Interpolating it into a template string yielded
 * `[object Object]`, so this tool returned nothing usable for any input. The
 * conversion belongs here rather than in the chunker: changing the chunker's
 * return shape would alter what `file_registry.skeleton_signature` stores and
 * what the retriever injects into RAG context.
 *
 * @param skeleton - The skeleton object produced by the chunker.
 * @param fileContent - The already-read file, used for atomic files whose
 * skeleton is only a `{ type: 'full' }` marker.
 * @returns A readable rendering of the file structure.
 */
function formatSkeleton(skeleton: object | null, fileContent: string): string {
  if (!skeleton) return '(no structure could be extracted)';

  // Atomic files (DTOs, entities, interfaces, enums) carry a marker instead of a
  // signature list, because the whole file *is* the structure.
  if ((skeleton as { type?: string }).type === 'full') return fileContent;

  const logic = skeleton as LogicSkeleton;
  if (!logic.imports && !logic.classes) return JSON.stringify(skeleton, null, 2);

  const sections: string[] = [];
  if (logic.imports?.length) {
    sections.push(`IMPORTS:\n${logic.imports.join('\n')}`);
  }
  for (const declared of logic.classes ?? []) {
    const methods = declared.methods?.length
      ? declared.methods.map((method) => `  - ${method}`).join('\n')
      : '  (no methods)';
    sections.push(`CLASS ${declared.name ?? '(anonymous)'}:\n${methods}`);
  }
  return sections.length ? sections.join('\n\n') : '(no classes or imports found)';
}

export const analyzeCodeStructureTool = tool(
  async ({ filePath }) => {
    log.debug(`analyze_code_structure called for: ${filePath}`);
    try {
      const rootDir = process.cwd();
      const authorization = authorizeFileAction('read_file', rootDir, filePath);
      if (authorization) return authorization;
      const targetPath = resolveWorkspacePath(rootDir, filePath);
      if (!targetPath) return '❌ DENIED: The target cannot be resolved safely.';
      if (!fs.existsSync(targetPath)) return `❌ Error: File ${filePath} not found.`;
      const content = fs.readFileSync(targetPath, "utf-8");
      const chunker = new NestChunker();
      const analysis = chunker.analyze(filePath, content, "dummy-hash");
      const structure = wrapUntrustedFileContent(filePath, formatSkeleton(analysis.skeleton, content));
      return `✅ STRUCTURE FOR ${filePath}:\n\n${structure}\n\n[TIP: Use this to create accurate mocks or understand service signatures.]`;
    } catch (error: any) {
      log.error(`Failed to analyze structure: ${error.message}`);
      return `❌ Error analyzing code structure: ${error.message}`;
    }
  },
  {
    name: "analyze_code_structure",
    description: "Analyzes the SKELETON of a file (classes, methods, signatures). Use this to understand how to MOCK services or call them correctly.",
    schema: z.object({
      filePath: z.string().describe("Relative path to the .ts file."),
    }),
  },
);

export const queryDependencyGraphTool = tool(
  async ({ filePath, direction }) => {
    log.debug(`query_dependency_graph called for: ${filePath} [${direction}]`);
    try {
      const db = AgentDB.getInstance();
      const normalizedPath = filePath.split(path.sep).join('/');
      let stmt;
      if (direction === "inbound") {
        stmt = db.prepare("SELECT source, relation FROM dependency_graph WHERE target = ? OR target = ?");
      } else {
        stmt = db.prepare("SELECT target, relation FROM dependency_graph WHERE source = ? OR source = ?");
      }
      const results = stmt.all(normalizedPath, filePath) as any[];
      if (results.length === 0) return `ℹ️ No ${direction} dependencies found for ${filePath}.`;
      let output = `🕸️ DEPENDENCY GRAPH (${direction.toUpperCase()}) for ${filePath}:\n\n`;
      results.forEach((row) => output += `- [${row.relation}] ${direction === "inbound" ? row.source : row.target}\n`);
      return output;
    } catch (error: any) {
      log.error(`Failed to query dependency graph: ${error.message}`);
      return `❌ Error querying dependency graph: ${error.message}`;
    }
  },
  {
    name: "query_dependency_graph",
    description: "Queries the dependency graph (inbound/outbound).",
    schema: z.object({
      filePath: z.string().describe("Relative path to the .ts file."),
      direction: z.enum(["inbound", "outbound"]),
    }),
  },
);
