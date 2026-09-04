import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import { log } from "./utils/logger";
import { AgentSecurityPolicy } from '../security';
import { runtimeRoot } from '../config/runtime-root';
import { WorkspaceDiscoveryService, WorkspaceDiscoveryError } from '../config/workspace-discovery';

const execFileAsync = promisify(execFile);
const securityPolicy = new AgentSecurityPolicy();

export const executeTestsTool = tool(
  async ({ filePath }) => {
    const rootDir = runtimeRoot();
    const authorization = securityPolicy.evaluate({ kind: 'run_test', rootDir });
    if (authorization.decision !== 'allow') return `❌ APPROVAL_REQUIRED: ${authorization.reason}`;

    const jestPath = path.join(rootDir, 'node_modules', 'jest', 'bin', 'jest.js');
    const args = ['--runInBand'];
    if (filePath) {
      const resolvedPath = path.resolve(rootDir, filePath);
      const fileAuthorization = securityPolicy.evaluate({ kind: 'read_file', rootDir, targetPath: filePath });
      if (fileAuthorization.decision !== 'allow' || !fs.existsSync(resolvedPath)) {
        return `❌ Error: The requested test file is not available for execution.`;
      }
      args.push(filePath, '--passWithNoTests', '--no-stack-trace');
    }
    log.tool(`🚀 Executing Jest...`);
    try {
      const { stdout } = await execFileAsync(process.execPath, [jestPath, ...args], { cwd: rootDir });
      log.tool("✅ TESTS PASSED.");
      return `✅ SUCCESS: Tests passed.\n${stdout.slice(-500)}`;
    } catch (error: any) {
      log.error("❌ TESTS FAILED.");
      const failure = error as { stdout?: string; stderr?: string; message?: string };
      const output = failure.stdout || failure.stderr || failure.message || 'Unknown test failure';
      return `❌ TEST FAILED.\n---------------------------------------------------\n${output.slice(-2500)}\n---------------------------------------------------`;
    }
  },
  {
    name: "run_tests",
    description: "Executes the test suite using Jest.",
    schema: z.object({ filePath: z.string().optional() }),
  },
);

export const integrityCheckTool = tool(
  async () => {
    const rootDir = runtimeRoot();
    const authorization = securityPolicy.evaluate({ kind: 'run_type_check', rootDir });
    if (authorization.decision !== 'allow') return `❌ APPROVAL_REQUIRED: ${authorization.reason}`;
    log.tool("Running TypeScript integrity check...");
    try {
      const projects = new WorkspaceDiscoveryService(rootDir).discover().typeScriptProjects;
      if (projects.length === 0) {
        return '⚠️ INTEGRITY CHECK UNSUPPORTED: no tsconfig.json was discovered under the pinned repository root.';
      }
      const tscPath = path.join(rootDir, 'node_modules', 'typescript', 'bin', 'tsc');
      const outputs: string[] = [];
      for (const project of projects) {
        const { stdout } = await execFileAsync(
          process.execPath,
          [tscPath, '--noEmit', '--project', project.absolutePath],
          { cwd: rootDir },
        );
        outputs.push(`✅ ${project.relativePath}${stdout.length > 0 ? `\n${stdout}` : ''}`);
      }
      log.tool("TypeScript integrity check PASSED.");
      return `✅ INTEGRITY CHECK PASSED.\n${outputs.join('\n')}`;
    } catch (error: any) {
      if (error instanceof WorkspaceDiscoveryError) {
        return `⚠️ INTEGRITY CHECK UNSUPPORTED: ${error.message}`;
      }
      const failure = error as { stdout?: string; stderr?: string; message?: string };
      const errorMessage = failure.stdout || failure.stderr || failure.message || "Unknown error";
      log.error(`TypeScript integrity check FAILED.\n${errorMessage}`);
      return `❌ INTEGRITY CHECK FAILED:\n${errorMessage}`;
    }
  },
  {
    name: "run_integrity_check",
    description: "Runs tsc --noEmit to verify type safety.",
    schema: z.object({}),
  },
);
