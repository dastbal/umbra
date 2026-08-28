import * as fs from 'fs';
import * as path from 'path';

/** A project-relative file and the symbols worth exposing to an analysis agent. */
export interface EvidenceManifestEntry {
  /** Relative path from the project root. */
  path: string;
  /** Case-insensitive fragments used to select relevant source lines. */
  patterns: string[];
}

/** A bounded, machine-collected snapshot of source paths and evidence snippets. */
export interface WorkspaceEvidence {
  /** Absolute project root used for collection. */
  rootDir: string;
  /** Existing project-relative paths from the requested manifest. */
  files: string[];
  /** Selected, line-numbered snippets; unrelated file content is omitted. */
  snippets: Array<{ path: string; lines: string[] }>;
}

const DEFAULT_MANIFEST: EvidenceManifestEntry[] = [
  { path: 'package.json', patterns: ['"scripts"', '"dependencies"', '"deepagents"', '"jest"', 'type-check', 'langsmith'] },
  { path: 'src/bin/cli.ts', patterns: ['.command("init")', '.command("deep")', '.command("orchestrate")', 'DeepAgentFactory'] },
  { path: 'src/core/agent/deep-agent-factory.ts', patterns: ['export class DeepAgentFactory', 'public static async create', 'createAnalysis', 'createOrchestrator', 'subagents:', 'buildCheckpointer', 'enableContextCompression', 'ContextCompressor'] },
  { path: 'src/core/agent/factory.ts', patterns: ['export class AgentFactory', 'public static async create'] },
  { path: 'src/core/agent/graph-factory.ts', patterns: ['export class GraphAgentFactory', 'public static async create'] },
  { path: 'src/core/config/agent-config.ts', patterns: ['agent.config.json', 'supervisor:', 'researcher:', 'coder:', 'verifier:', 'maxRetries', 'maxDelegationDepth', 'singleWriter'] },
  { path: 'src/core/state/db.ts', patterns: ['memory.db', 'CREATE TABLE', 'file_registry', 'dependency_graph', 'code_chunks'] },
  { path: 'src/core/rag/indexer.ts', patterns: ['indexProject', 'embedDocuments', 'code_chunks'] },
  { path: 'src/core/agent/context-compressor.ts', patterns: ['class ContextCompressor', 'MAX_CONTEXT_TOKENS', 'compress', 'estimateTokens'] },
  { path: 'src/core/tools/file-tools.ts', patterns: ['safeWriteFileTool', 'createBackup', 'Access denied', 'write_file'] },
  { path: 'src/core/tools/testing-tools.ts', patterns: ['run_tests', 'run_integrity_check', 'npx tsc', 'npm test'] },
  { path: 'src/core/subagents/researcher.subagent.ts', patterns: ['READ-ONLY', 'responseFormat', 'safeReadFileTool'] },
  { path: 'src/core/subagents/coder.subagent.ts', patterns: ['safeWriteFileTool', 'safe_write_file', 'TDD'] },
  { path: 'src/core/subagents/verifier.subagent.ts', patterns: ['read-only', 'run_tests', 'run_integrity_check'] },
];

const SENSITIVE_VALUE_PATTERN = /("(?:api[_-]?key|secret|password|token|credential|private[_-]?key)"\s*:\s*")([^"\\]*(?:\\.[^"\\]*)*)(")/gi;
const MAX_SNIPPET_LINE_LENGTH = 280;
const MAX_SNIPPETS_PER_FILE = 12;

/**
 * Collects a bounded manifest of real project evidence without executing tools
 * or exposing complete source files to the model.
 *
 * @param rootDir - Project root to inspect.
 * @param manifest - Optional manifest, primarily useful for deterministic tests.
 * @returns Existing paths and selected line-numbered snippets.
 */
export function collectWorkspaceEvidence(
  rootDir: string,
  manifest: EvidenceManifestEntry[] = DEFAULT_MANIFEST,
): WorkspaceEvidence {
  const resolvedRoot = path.resolve(rootDir);
  const files: string[] = [];
  const snippets: Array<{ path: string; lines: string[] }> = [];

  for (const entry of manifest) {
    const relativePath = entry.path.replaceAll('\\', '/');
    const absolutePath = path.resolve(resolvedRoot, relativePath);
    if (!absolutePath.startsWith(`${resolvedRoot}${path.sep}`) || !fs.existsSync(absolutePath)) {
      continue;
    }

    files.push(relativePath);
    let source: string;
    try {
      source = fs.readFileSync(absolutePath, 'utf8');
    } catch {
      continue;
    }

    const loweredPatterns = entry.patterns.map((pattern) => pattern.toLowerCase());
    const selectedLines = source
      .split(/\r?\n/)
      .map((line, index) => ({ line, index: index + 1 }))
      .filter(({ line }) => {
        const loweredLine = line.toLowerCase();
        return loweredPatterns.some((pattern) => loweredLine.includes(pattern));
      })
      .slice(0, MAX_SNIPPETS_PER_FILE)
      .map(({ line, index }) => `${index}: ${sanitizeLine(line)}`);

    if (selectedLines.length > 0) snippets.push({ path: relativePath, lines: selectedLines });
  }

  return { rootDir: resolvedRoot, files, snippets };
}

/**
 * Formats the bounded manifest for inclusion in a system prompt.
 *
 * @param evidence - Collected project evidence.
 * @returns A compact, source-backed text manifest.
 */
export function formatWorkspaceEvidence(evidence: WorkspaceEvidence): string {
  const existingFiles = evidence.files.length > 0
    ? evidence.files.map((file) => `- ${file}`).join('\n')
    : '- No manifest files were found.';
  const snippets = evidence.snippets.length > 0
    ? evidence.snippets
        .map((entry) => entry.lines.map((line) => `${entry.path}:${line}`).join('\n'))
        .join('\n')
    : 'No matching evidence snippets were found.';

  return `
MACHINE-COLLECTED WORKSPACE EVIDENCE (read-only; do not treat absent entries as facts)
Existing manifest files:
${existingFiles}

Selected source snippets (path:line):
${snippets}
`;
}

/** Redacts common secret-value fields and bounds a line before prompt injection. */
function sanitizeLine(line: string): string {
  const redacted = line.replace(SENSITIVE_VALUE_PATTERN, '$1[redacted]$3');
  return redacted.length > MAX_SNIPPET_LINE_LENGTH
    ? `${redacted.slice(0, MAX_SNIPPET_LINE_LENGTH)}…`
    : redacted;
}
