import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';

import { runtimeRoot } from '../config/runtime-root';
import { WorkspaceDiscoveryError, WorkspaceDiscoveryService } from '../config/workspace-discovery';
import { readIndexStamp } from '../rag/index-stamp';
import { inspectIndexIntegrity } from '../rag/index-integrity';
import {
  formatGraphRagContextForLLM,
  DetectiveTrace,
  GraphRagSearchResult,
  GraphRagService,
  GraphRagStrategy,
} from '../rag/graphrag';
import {
  findBindingsForModule,
  findBindingsForToken,
  findInjectionsForToken,
  normalizeToken,
} from '../rag/nest-graph-store';
import { AgentSecurityPolicy } from '../security';
import { AgentDB } from '../state/db';
import { clearPendingRetrievalAlias, stageRetrievalAlias } from '../rag/retrieval-memory';
import { AdrIndexEntry, buildAdrIndex } from './adr-index';
import { createToolResultSchema, ToolResult } from './tool-result';

const execFileAsync = promisify(execFile);
const securityPolicy = new AgentSecurityPolicy();

const adrEntrySchema = z.object({
  id: z.string(), module: z.string(), path: z.string(), title: z.string(),
  statusLabel: z.string(), context: z.string(), size: z.number(), mtimeMs: z.number(),
});
export const adrCatalogDataSchema = z.object({
  catalogStatus: z.enum(['cached', 'rebuilt']),
  generatedAt: z.string(),
  module: z.string().optional(),
  availableModules: z.array(z.string()),
  entries: z.array(adrEntrySchema),
});
export const adrCatalogResultSchema = createToolResultSchema(
  z.enum(['ADR_CATALOG_READY', 'ADR_CATALOG_EMPTY', 'ADR_MODULE_NOT_FOUND', 'ADR_CATALOG_ERROR']),
  adrCatalogDataSchema,
);
export type AdrCatalogData = z.infer<typeof adrCatalogDataSchema>;
export type AdrCatalogResult = ToolResult<z.infer<typeof adrCatalogResultSchema>['code'], AdrCatalogData>;

const dependencyRelationSchema = z.object({ path: z.string(), relation: z.string() });
export const dependencyGraphDataSchema = z.object({
  filePath: z.string(), direction: z.enum(['inbound', 'outbound']), relations: z.array(dependencyRelationSchema),
});
export const dependencyGraphResultSchema = createToolResultSchema(
  z.enum(['DEPENDENCIES_FOUND', 'NO_DEPENDENCIES', 'DEPENDENCY_GRAPH_ERROR']),
  dependencyGraphDataSchema,
);
export type DependencyGraphData = z.infer<typeof dependencyGraphDataSchema>;
export type DependencyGraphResult = ToolResult<z.infer<typeof dependencyGraphResultSchema>['code'], DependencyGraphData>;

const nestBindingSchema = z.object({
  filePath: z.string(), module: z.string(), kind: z.string(), token: z.string(),
  useKind: z.string().optional(), dynamic: z.boolean(),
});
const nestInjectionSchema = z.object({
  filePath: z.string(), consumer: z.string(), token: z.string(), explicit: z.boolean(),
});
export const nestGraphDataSchema = z.object({
  name: z.string(), normalizedName: z.string(), direction: z.enum(['provides', 'injects', 'module']),
  bindings: z.array(nestBindingSchema), injections: z.array(nestInjectionSchema),
});
export const nestGraphResultSchema = createToolResultSchema(
  z.enum(['NEST_BINDINGS_FOUND', 'NO_NEST_BINDINGS', 'NEST_GRAPH_ERROR']),
  nestGraphDataSchema,
);
export type NestGraphData = z.infer<typeof nestGraphDataSchema>;
export type NestGraphResult = ToolResult<z.infer<typeof nestGraphResultSchema>['code'], NestGraphData>;

export const integrityDataSchema = z.object({
  projects: z.array(z.object({ path: z.string(), passed: z.boolean(), output: z.string() })),
});
export const integrityResultSchema = createToolResultSchema(
  z.enum(['INTEGRITY_PASSED', 'INTEGRITY_FAILED', 'INTEGRITY_UNSUPPORTED', 'INTEGRITY_BLOCKED', 'INTEGRITY_ERROR']),
  integrityDataSchema,
);
export type IntegrityData = z.infer<typeof integrityDataSchema>;
export type IntegrityResult = ToolResult<z.infer<typeof integrityResultSchema>['code'], IntegrityData>;

const retrievalProvenanceSchema = z.object({
  provider: z.enum(['vertex', 'ollama']), model: z.string(), chunksSearched: z.number(),
  dimensions: z.number(), rankedIn: z.enum(['sql', 'javascript']),
});
const retrievalChunkSchema = z.object({
  type: z.string(), content: z.string(), startLine: z.number().int(), endLine: z.number().int(),
  className: z.string().optional(), methodName: z.string().optional(),
  artifactKind: z.literal('prisma-schema').optional(),
});
const graphReadinessSchema = z.object({
  ready: z.boolean(), reason: z.string(), pendingFiles: z.number().int().nonnegative(),
});
const retrievalRecommendationSchema = z.object({
  state: z.enum(['sufficient', 'follow-up', 'clarify']),
  tool: z.enum(['query_dependency_graph', 'query_nest_graph']).optional(),
  subject: z.string().optional(),
  reason: z.string(),
});
const retrievalStrategySchema = z.object({
  policy: z.string(), plan: z.enum(['hybrid', 'dependency-1', 'dependency-2', 'nest', 'combined']),
  depthReached: z.number().int().nonnegative(), nodesVisited: z.number().int().nonnegative(),
  relationsInspected: z.number().int().nonnegative(), discardedBranches: z.number().int().nonnegative(),
  stopReason: z.enum(['not-applicable', 'abstained', 'no-seeds', 'marginal-evidence', 'depth-budget', 'relation-budget', 'node-budget']),
  marginalEvidence: z.array(z.object({
    depth: z.number().int().positive(), frontierNodes: z.number().int().nonnegative(),
    relationsInspected: z.number().int().nonnegative(), novelEvidence: z.number().int().nonnegative(),
    discardedBranches: z.number().int().nonnegative(),
  })),
  estimatedTokens: z.number().int().nonnegative(), elapsedMs: z.number().nonnegative(),
  readiness: z.object({ dependency: graphReadinessSchema, nest: graphReadinessSchema }),
  recommendation: retrievalRecommendationSchema,
});
export const codebaseSearchDataSchema = z.object({
  query: z.string(), clarification: z.string().optional(), recoveredWithContext: z.boolean(),
  abstentionReason: z.enum(['unknown_terms', 'ungrounded']).optional(),
  unknownTerms: z.array(z.string()),
  ignoredModifiers: z.array(z.string()),
  files: z.array(z.object({
    path: z.string(), origin: z.enum(['seed', 'graph']), evidence: z.enum(['semantic', 'lexical', 'hybrid', 'graph']),
    score: z.number(), relations: z.array(z.string()),
    imports: z.array(z.string()), chunks: z.array(retrievalChunkSchema),
  })),
  provenance: retrievalProvenanceSchema.optional(),
  // Absent only when the semantic readiness gate blocks execution before the
  // deterministic planner can observe an index. Successful and abstained
  // searches always carry this additive strategy projection.
  retrieval: retrievalStrategySchema.optional(),
});
export const codebaseSearchResultSchema = createToolResultSchema(
  z.enum(['CODEBASE_MATCHES_FOUND', 'CODEBASE_NO_EVIDENCE', 'CODEBASE_INDEX_UNAVAILABLE', 'CODEBASE_SEARCH_ERROR']),
  codebaseSearchDataSchema,
);
export type CodebaseSearchData = z.infer<typeof codebaseSearchDataSchema>;
export type CodebaseSearchResult = ToolResult<z.infer<typeof codebaseSearchResultSchema>['code'], CodebaseSearchData>;

const graphRagBudgetSchema = z.object({
  maxSeeds: z.number().int().nonnegative(), maxDepth: z.number().int().nonnegative(),
  maxNodes: z.number().int().nonnegative(), maxRelations: z.number().int().nonnegative(),
  maxChunks: z.number().int().nonnegative(), maxEstimatedTokens: z.number().int().nonnegative(),
});
const graphRagBranchSchema = z.object({
  from: z.string(), to: z.string(), relation: z.string(), depth: z.number().int().positive(),
  outcome: z.enum(['accepted', 'duplicate', 'budget', 'no-chunks']),
});
const graphRagQualitySchema = z.object({
  corpusCaseId: z.string().optional(), sampleSize: z.union([z.literal(0), z.literal(1)]),
  hitAt1: z.number().optional(), mrr: z.number().optional(), falseAbstention: z.boolean().optional(),
  correctAbstention: z.boolean().optional(),
});
const graphRagPlanTraceSchema = z.object({
  plan: z.enum(['hybrid', 'dependency-1', 'dependency-2', 'nest', 'combined']), eligible: z.boolean(),
  reason: z.string().optional(), selectedPaths: z.array(z.string()),
  selectedEvidence: z.array(z.object({
    path: z.string(), origin: z.enum(['seed', 'graph']), score: z.number(), relations: z.array(z.string()),
  })),
  branches: z.array(graphRagBranchSchema), elapsedMs: z.number().nonnegative(),
  metrics: retrievalStrategySchema.pick({
    depthReached: true, nodesVisited: true, relationsInspected: true, stopReason: true,
    marginalEvidence: true, discardedBranches: true, estimatedTokens: true,
  }),
  quality: graphRagQualitySchema, recommendation: retrievalRecommendationSchema,
});
export const graphRagInvestigationDataSchema = z.object({
  runId: z.string(), persisted: z.literal(false), mode: z.enum(['standard', 'deep']),
  indexFingerprint: z.string(), budget: graphRagBudgetSchema, plans: z.array(graphRagPlanTraceSchema),
});
export const graphRagInvestigationResultSchema = createToolResultSchema(
  z.enum(['GRAPHRAG_INVESTIGATION_COMPLETE', 'GRAPHRAG_INVESTIGATION_ERROR']),
  graphRagInvestigationDataSchema,
);
export type GraphRagInvestigationData = z.infer<typeof graphRagInvestigationDataSchema>;
export type GraphRagInvestigationResult = ToolResult<
  z.infer<typeof graphRagInvestigationResultSchema>['code'],
  GraphRagInvestigationData
>;

const indexPhaseSchema = z.enum(['awaiting-root', 'starting', 'probing', 'indexing', 'ready', 'unavailable', 'failed', 'skipped']);
export const indexStatusDataSchema = z.object({
  lifecycle: z.object({ phase: indexPhaseSchema, message: z.string(), startedAt: z.number().optional() }),
  stamp: z.object({ provider: z.string(), model: z.string(), dimensions: z.number(), indexedAt: z.number(), filesIndexed: z.number(), status: z.enum(['complete', 'partial', 'empty']) }).optional(),
  integrity: z.object({ healthy: z.boolean(), databaseExists: z.boolean(), schemaValid: z.boolean(), discoveryValid: z.boolean(), discoveredFiles: z.number(), files: z.number(), indexedFiles: z.number(), skippedFiles: z.number(), chunks: z.number(), missingVectors: z.number(), pendingPaths: z.array(z.string()), stalePaths: z.array(z.string()), diagnostic: z.string().optional() }).optional(),
});
export const indexStatusResultSchema = createToolResultSchema(z.enum(['INDEX_STATUS_READY', 'INDEX_STATUS_AWAITING_ROOT', 'INDEX_STATUS_DEGRADED', 'INDEX_STATUS_ERROR']), indexStatusDataSchema);
export type IndexStatusData = z.infer<typeof indexStatusDataSchema>;
export type IndexStatusResult = ToolResult<z.infer<typeof indexStatusResultSchema>['code'], IndexStatusData>;

/** Captures live lifecycle, persisted provenance, and durable integrity without conflating them. */
export function executeIndexStatus(rootDir: string | undefined, lifecycle: IndexStatusData['lifecycle']): IndexStatusResult {
  const data: IndexStatusData = { lifecycle };
  if (rootDir === undefined) return { schemaVersion: 1, status: 'blocked', code: 'INDEX_STATUS_AWAITING_ROOT', summary: lifecycle.message, data, evidence: [], diagnostics: [{ severity: 'error', code: 'INDEX_STATUS_AWAITING_ROOT', message: lifecycle.message }], truncated: false, retryable: false };
  try {
    const stamp = readIndexStamp(rootDir);
    const integrity = inspectIndexIntegrity(rootDir, stamp === undefined ? undefined : { provider: stamp.provider, model: stamp.model });
    if (stamp !== undefined) data.stamp = { provider: stamp.provider, model: stamp.model, dimensions: stamp.dimensions, indexedAt: stamp.indexedAt, filesIndexed: stamp.filesIndexed, status: stamp.status };
    data.integrity = { healthy: integrity.healthy, databaseExists: integrity.databaseExists, schemaValid: integrity.schemaValid, discoveryValid: integrity.discoveryValid, discoveredFiles: integrity.discoveredFiles, files: integrity.files, indexedFiles: integrity.indexedFiles, skippedFiles: integrity.skippedFiles, chunks: integrity.chunks, missingVectors: integrity.missingVectors, pendingPaths: [...integrity.pendingPaths], stalePaths: [...integrity.stalePaths], ...(integrity.diagnostic === undefined ? {} : { diagnostic: integrity.diagnostic }) };
    return { schemaVersion: 1, status: integrity.healthy ? 'success' : 'partial', code: integrity.healthy ? 'INDEX_STATUS_READY' : 'INDEX_STATUS_DEGRADED', summary: integrity.healthy ? 'The code index has complete usable coverage.' : 'The code index is inspectable but has coverage or integrity limitations.', data, evidence: [], diagnostics: integrity.diagnostic === undefined ? [] : [{ severity: 'warning', code: 'INDEX_INTEGRITY', message: integrity.diagnostic }], truncated: false, retryable: false };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { schemaVersion: 1, status: 'error', code: 'INDEX_STATUS_ERROR', summary: 'Index status inspection failed.', data, evidence: [], diagnostics: [{ severity: 'error', code: 'INDEX_STATUS_ERROR', message }], truncated: false, retryable: false };
  }
}

/** Formats the same typed snapshot for the text index-status resource. */
export function formatIndexStatusForModel(result: IndexStatusResult): string {
  const lines = [`state:         ${result.data.lifecycle.phase}`, `message:       ${result.data.lifecycle.message}`];
  if (result.data.lifecycle.startedAt !== undefined) lines.push(`started at:    ${new Date(result.data.lifecycle.startedAt).toISOString()}`);
  if (result.data.stamp !== undefined) lines.push(`provider:      ${result.data.stamp.provider}`, `model:         ${result.data.stamp.model}`, `stamp status:  ${result.data.stamp.status}`, `files indexed: ${result.data.stamp.filesIndexed}`);
  if (result.data.integrity !== undefined) lines.push(`healthy:       ${result.data.integrity.healthy}`, `discovered:    ${result.data.integrity.discoveredFiles}`, `indexed:       ${result.data.integrity.indexedFiles}`, `chunks:        ${result.data.integrity.chunks}`, `pending:       ${result.data.integrity.pendingPaths.length}`, `stale:         ${result.data.integrity.stalePaths.length}`);
  return lines.join('\n');
}

/** Reads the ADR catalog and preserves its metadata before rendering. */
export function executeListAdrs(
  input: { refresh?: boolean; module?: string },
  rootDir: string = runtimeRoot(),
): AdrCatalogResult {
  const emptyData = (entries: AdrIndexEntry[] = []): AdrCatalogData => ({
    catalogStatus: 'cached', generatedAt: '', module: input.module,
    availableModules: [], entries,
  });
  try {
    const catalog = buildAdrIndex(rootDir, input.refresh === true);
    const availableModules = [...new Set(catalog.entries.map((entry) => entry.module))].sort();
    const entries = input.module === undefined
      ? catalog.entries
      : catalog.entries.filter((entry) => entry.module === input.module);
    const data: AdrCatalogData = {
      catalogStatus: catalog.status,
      generatedAt: catalog.generatedAt,
      ...(input.module === undefined ? {} : { module: input.module }),
      availableModules,
      entries,
    };
    if (input.module !== undefined && entries.length === 0) {
      return { schemaVersion: 1, status: 'empty', code: 'ADR_MODULE_NOT_FOUND',
        summary: `ADR module "${input.module}" was not found.`, data, evidence: [], diagnostics: [],
        truncated: false, retryable: false, nextAction: `Use one of: ${availableModules.join(', ') || '(none)'}.` };
    }
    if (entries.length === 0) {
      return { schemaVersion: 1, status: 'empty', code: 'ADR_CATALOG_EMPTY',
        summary: 'No Architecture Decision Records were discovered.', data, evidence: [], diagnostics: [],
        truncated: false, retryable: false };
    }
    return { schemaVersion: 1, status: 'success', code: 'ADR_CATALOG_READY',
      summary: `${entries.length} Architecture Decision Record${entries.length === 1 ? '' : 's'} available.`,
      data, evidence: entries.map((entry) => ({ path: entry.path, reason: entry.context })),
      diagnostics: [], truncated: false, retryable: false };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { schemaVersion: 1, status: 'error', code: 'ADR_CATALOG_ERROR',
      summary: 'The ADR catalog could not be read.', data: emptyData(), evidence: [],
      diagnostics: [{ severity: 'error', code: 'ADR_CATALOG_ERROR', message }],
      truncated: false, retryable: false };
  }
}

/** Formats an ADR result for the model while retaining the existing compact evidence. */
export function formatAdrCatalogForModel(result: AdrCatalogResult): string {
  if (result.status === 'error') return `❌ Error indexing ADR files: ${result.diagnostics[0].message}`;
  if (result.code === 'ADR_MODULE_NOT_FOUND') {
    return `❌ ${result.summary} Available modules: ${result.data.availableModules.join(', ') || '(none)'}.`;
  }
  if (result.data.entries.length === 0) return 'ADR catalog: no decision records were discovered.';
  const lines = result.data.entries.map((entry) =>
    `- [${entry.module}] ${entry.id} — ${entry.title} [${entry.statusLabel}]; context: ${entry.context}`,
  );
  return `ADR catalog (${result.data.catalogStatus}; ${result.data.entries.length} decisions):\n${lines.join('\n')}`;
}

/** Queries the persisted file dependency graph without formatting it. */
export function executeDependencyGraph(input: {
  filePath: string; direction: 'inbound' | 'outbound';
}): DependencyGraphResult {
  const data: DependencyGraphData = { ...input, relations: [] };
  try {
    const db = AgentDB.getInstance();
    const normalizedPath = input.filePath.split(path.sep).join('/');
    const sql = input.direction === 'inbound'
      ? 'SELECT source AS path, relation FROM dependency_graph WHERE target = ? OR target = ?'
      : 'SELECT target AS path, relation FROM dependency_graph WHERE source = ? OR source = ?';
    const relations = db.prepare(sql).all(normalizedPath, input.filePath) as Array<{ path: string; relation: string }>;
    data.relations = relations;
    if (relations.length === 0) {
      return { schemaVersion: 1, status: 'empty', code: 'NO_DEPENDENCIES',
        summary: `No ${input.direction} dependencies found for ${input.filePath}.`, data,
        evidence: [], diagnostics: [], truncated: false, retryable: false };
    }
    return { schemaVersion: 1, status: 'success', code: 'DEPENDENCIES_FOUND',
      summary: `${relations.length} ${input.direction} dependenc${relations.length === 1 ? 'y' : 'ies'} found.`, data,
      evidence: relations.map((relation) => ({ path: relation.path, reason: relation.relation })),
      diagnostics: [], truncated: false, retryable: false };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { schemaVersion: 1, status: 'error', code: 'DEPENDENCY_GRAPH_ERROR',
      summary: 'The dependency graph query failed.', data, evidence: [],
      diagnostics: [{ severity: 'error', code: 'DEPENDENCY_GRAPH_ERROR', message }],
      truncated: false, retryable: false };
  }
}

/** Formats dependency graph relations for the model. */
export function formatDependencyGraphForModel(result: DependencyGraphResult): string {
  if (result.status === 'error') return `❌ Error querying dependency graph: ${result.diagnostics[0].message}`;
  if (result.data.relations.length === 0) return `ℹ️ ${result.summary}`;
  const lines = result.data.relations.map((relation) => `- [${relation.relation}] ${relation.path}`);
  return `🕸️ DEPENDENCY GRAPH (${result.data.direction.toUpperCase()}) for ${result.data.filePath}:\n\n${lines.join('\n')}\n`;
}

/** Queries NestJS bindings and injections without presentation markup. */
export function executeNestGraph(input: {
  name: string; direction: 'provides' | 'injects' | 'module';
}): NestGraphResult {
  const normalizedName = normalizeToken(input.name);
  const data: NestGraphData = { ...input, normalizedName, bindings: [], injections: [] };
  try {
    const db = AgentDB.getInstance();
    if (input.direction === 'provides') data.bindings = [...findBindingsForToken(db, input.name)];
    else if (input.direction === 'injects') data.injections = [...findInjectionsForToken(db, input.name)];
    else data.bindings = [...findBindingsForModule(db, input.name)];
    const count = data.bindings.length + data.injections.length;
    if (count === 0) {
      return { schemaVersion: 1, status: 'empty', code: 'NO_NEST_BINDINGS',
        summary: `No NestJS ${input.direction} result was found for ${input.name}.`, data,
        evidence: [], diagnostics: [], truncated: false, retryable: false };
    }
    return { schemaVersion: 1, status: 'success', code: 'NEST_BINDINGS_FOUND',
      summary: `${count} NestJS wiring entr${count === 1 ? 'y' : 'ies'} found.`, data,
      evidence: [...data.bindings.map((item) => ({ path: item.filePath, reason: item.kind })),
        ...data.injections.map((item) => ({ path: item.filePath, reason: item.explicit ? '@Inject' : 'type injection' }))],
      diagnostics: [], truncated: false, retryable: false };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { schemaVersion: 1, status: 'error', code: 'NEST_GRAPH_ERROR',
      summary: 'The NestJS graph query failed.', data, evidence: [],
      diagnostics: [{ severity: 'error', code: 'NEST_GRAPH_ERROR', message }],
      truncated: false, retryable: false };
  }
}

/** Formats NestJS wiring evidence for the model. */
export function formatNestGraphForModel(result: NestGraphResult): string {
  if (result.status === 'error') return `❌ Error querying the NestJS graph: ${result.diagnostics[0].message}`;
  if (result.code === 'NO_NEST_BINDINGS') return `ℹ️ ${result.summary}`;
  if (result.data.direction === 'injects') {
    const lines = result.data.injections.map((item) =>
      `- ${item.consumer} (${item.explicit ? '@Inject' : 'by type'})\n  ${item.filePath}`,
    );
    return `🧩 **${result.data.normalizedName}** is injected by ${result.data.injections.length} class${result.data.injections.length === 1 ? '' : 'es'}.\nThese are what break if it stops being provided or exported:\n\n${lines.join('\n')}`;
  }
  if (result.data.direction === 'provides') {
    const lines = result.data.bindings.map((item) => {
      const how = item.useKind === undefined ? '' : ` (${item.useKind})`;
      const when = item.dynamic ? ' — only when registered dynamically' : '';
      return `- ${item.module} **${item.kind}**${how}${when}\n  ${item.filePath}`;
    });
    return `🧩 **${result.data.normalizedName}** is bound by ${result.data.bindings.length} entr${result.data.bindings.length === 1 ? 'y' : 'ies'}:\n\n${lines.join('\n')}`;
  }
  const byKind = new Map<string, string[]>();
  for (const item of result.data.bindings) {
    const entry = `${item.token}${item.useKind === undefined ? '' : ` (${item.useKind})`}${item.dynamic ? ' [dynamic]' : ''}`;
    byKind.set(item.kind, [...(byKind.get(item.kind) ?? []), entry]);
  }
  const sections = [...byKind.entries()].map(([kind, tokens]) => `**${kind}s**: ${tokens.join(', ')}`);
  return `🧩 **${result.data.name}** (${result.data.bindings[0]?.filePath ?? 'unknown'})\n\n${sections.join('\n')}`;
}

/** Runs TypeScript no-emit checks for every discovered project. */
export async function executeIntegrityCheck(rootDir: string = runtimeRoot()): Promise<IntegrityResult> {
  const data: IntegrityData = { projects: [] };
  const authorization = securityPolicy.evaluate({ kind: 'run_type_check', rootDir });
  if (authorization.decision !== 'allow') {
    return { schemaVersion: 1, status: 'blocked', code: 'INTEGRITY_BLOCKED',
      summary: 'The integrity check requires operator approval.', data, evidence: [],
      diagnostics: [{ severity: 'error', code: 'INTEGRITY_BLOCKED', message: authorization.reason }],
      truncated: false, retryable: false };
  }
  try {
    const projects = new WorkspaceDiscoveryService(rootDir).discover().typeScriptProjects;
    if (projects.length === 0) {
      return { schemaVersion: 1, status: 'empty', code: 'INTEGRITY_UNSUPPORTED',
        summary: 'No tsconfig.json was discovered under the project root.', data, evidence: [],
        diagnostics: [{ severity: 'warning', code: 'INTEGRITY_UNSUPPORTED', message: 'No TypeScript project was discovered.' }],
        truncated: false, retryable: false };
    }
    const tscPath = path.join(rootDir, 'node_modules', 'typescript', 'bin', 'tsc');
    for (const project of projects) {
      try {
        const { stdout } = await execFileAsync(process.execPath, [tscPath, '--noEmit', '--project', project.absolutePath], { cwd: rootDir });
        data.projects.push({ path: project.relativePath, passed: true, output: stdout });
      } catch (error: unknown) {
        const failure = error as { stdout?: string; stderr?: string; message?: string };
        data.projects.push({ path: project.relativePath, passed: false, output: failure.stdout || failure.stderr || failure.message || 'Unknown compiler failure' });
      }
    }
    const failed = data.projects.filter((project) => !project.passed);
    if (failed.length > 0) {
      const firstFailure = failed[0];
      return { schemaVersion: 1, status: 'error', code: 'INTEGRITY_FAILED',
        summary: `${failed.length} TypeScript project${failed.length === 1 ? '' : 's'} failed.`, data, evidence: [],
        diagnostics: [
          { severity: 'error', code: 'TYPESCRIPT_ERROR', message: firstFailure.output, path: firstFailure.path },
          ...failed.slice(1).map((project) => ({
            severity: 'error' as const,
            code: 'TYPESCRIPT_ERROR',
            message: project.output,
            path: project.path,
          })),
        ],
        truncated: false, retryable: false };
    }
    return { schemaVersion: 1, status: 'success', code: 'INTEGRITY_PASSED',
      summary: `${data.projects.length} TypeScript project${data.projects.length === 1 ? '' : 's'} passed.`, data,
      evidence: data.projects.map((project) => ({ path: project.path, reason: 'tsc --noEmit passed' })),
      diagnostics: [], truncated: false, retryable: false };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const unsupported = error instanceof WorkspaceDiscoveryError;
    return { schemaVersion: 1, status: unsupported ? 'empty' : 'error',
      code: unsupported ? 'INTEGRITY_UNSUPPORTED' : 'INTEGRITY_ERROR',
      summary: unsupported ? 'The TypeScript workspace is unsupported.' : 'The integrity check failed.', data,
      evidence: [], diagnostics: [{ severity: unsupported ? 'warning' : 'error', code: unsupported ? 'INTEGRITY_UNSUPPORTED' : 'INTEGRITY_ERROR', message }],
      truncated: false, retryable: false };
  }
}

/** Formats compiler results for the model. */
export function formatIntegrityForModel(result: IntegrityResult): string {
  if (result.status === 'blocked') return `❌ APPROVAL_REQUIRED: ${result.diagnostics[0].message}`;
  if (result.code === 'INTEGRITY_UNSUPPORTED') return `⚠️ INTEGRITY CHECK UNSUPPORTED: ${result.diagnostics[0]?.message ?? result.summary}`;
  if (result.status === 'error') {
    return `❌ INTEGRITY CHECK FAILED:\n${result.data.projects.filter((project) => !project.passed).map((project) => project.output).join('\n') || result.diagnostics[0].message}`;
  }
  const projects = result.data.projects.map((project) => `✅ ${project.path}${project.output ? `\n${project.output}` : ''}`);
  return `✅ INTEGRITY CHECK PASSED.\n${projects.join('\n')}`;
}

/** Searches the code index and retains evidence before model formatting. */
export async function executeCodebaseSearch(input: {
  query: string; context?: string;
}): Promise<{ result: CodebaseSearchResult; modelContent: string }> {
  const emptyData: CodebaseSearchData = {
    query: input.query, ...(input.context === undefined ? {} : { clarification: input.context }),
    recoveredWithContext: false, unknownTerms: [], ignoredModifiers: [], files: [], retrieval: emptyRetrievalStrategy(),
  };
  try {
    const stamp = readIndexStamp(runtimeRoot());
    if (stamp?.status === 'empty') {
      const message = stamp.diagnostic ?? 'No indexable source files were discovered.';
      const result: CodebaseSearchResult = { schemaVersion: 1, status: 'blocked', code: 'CODEBASE_INDEX_UNAVAILABLE',
        summary: 'The code index is unavailable.', data: emptyData, evidence: [],
        diagnostics: [{ severity: 'error', code: 'CODEBASE_INDEX_UNAVAILABLE', message }],
        truncated: false, retryable: false, nextAction: 'Run umbra index after confirming the project root.' };
      return { result, modelContent: `Code index unavailable: ${message}` };
    }
    clearPendingRetrievalAlias();
    const graphRag = new GraphRagService();
    const contextResult = await graphRag.search(input.query, input.context);
    const candidate = contextResult.status === 'success' ? contextResult.learningCandidate : undefined;
    if (candidate !== undefined) stageRetrievalAlias(candidate);
    const data = toCodebaseSearchData(contextResult);
    if (contextResult.status === 'abstained') {
      const result: CodebaseSearchResult = { schemaVersion: 1, status: 'abstained', code: 'CODEBASE_NO_EVIDENCE',
        summary: contextResult.reason === 'unknown_terms'
          ? `No indexed evidence contains: ${contextResult.unknownTerms.join(', ')}.`
          : 'The nearest results lacked independent grounding evidence.',
        data, evidence: [], diagnostics: [], truncated: false, retryable: input.context === undefined,
        nextAction: input.context === undefined ? 'Clarify once with a repository symbol, path, or domain term.' : undefined };
      return { result, modelContent: formatGraphRagContextForLLM(contextResult) };
    }
    const evidence = contextResult.files.flatMap((file) => file.chunks.map((chunk) => ({
      path: file.filePath, startLine: chunk.metadata.startLine, endLine: chunk.metadata.endLine,
      reason: `${file.evidence}${chunk.metadata.methodName ? ` match for ${chunk.metadata.methodName}` : ' match'}`,
    })));
    const result: CodebaseSearchResult = { schemaVersion: 1, status: 'success', code: 'CODEBASE_MATCHES_FOUND',
      summary: `${contextResult.files.length} relevant file${contextResult.files.length === 1 ? '' : 's'} found.`,
      data, evidence, diagnostics: [], truncated: false, retryable: false,
      ...(recommendationNextAction(contextResult.strategy.recommendation) === undefined ? {} : {
        nextAction: recommendationNextAction(contextResult.strategy.recommendation),
      }),
    };
    return { result, modelContent: formatGraphRagContextForLLM(contextResult) };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const result: CodebaseSearchResult = { schemaVersion: 1, status: 'error', code: 'CODEBASE_SEARCH_ERROR',
      summary: 'The codebase search failed.', data: emptyData, evidence: [],
      diagnostics: [{ severity: 'error', code: 'CODEBASE_SEARCH_ERROR', message }],
      truncated: false, retryable: false };
    return { result, modelContent: `Codebase search failed: ${message}` };
  }
}

/**
 * Compares bounded GraphRAG plans for an MCP caller without persisting its question.
 *
 * @param input - Natural-language query and optional expanded local budget.
 * @returns Source-free deterministic plan comparison; never a promotion or a source write.
 */
export async function executeGraphRagInvestigation(input: {
  readonly query: string;
  readonly mode?: 'standard' | 'deep';
}): Promise<GraphRagInvestigationResult> {
  try {
    const trace = await new GraphRagService().compare(input.query, input.mode ?? 'standard');
    return {
      schemaVersion: 1,
      status: 'success',
      code: 'GRAPHRAG_INVESTIGATION_COMPLETE',
      summary: `${trace.plans.length} deterministic GraphRAG plan(s) compared without retaining a Detective trace.`,
      data: toGraphRagInvestigationData(trace),
      evidence: [],
      diagnostics: [],
      truncated: false,
      retryable: false,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      schemaVersion: 1,
      status: 'error',
      code: 'GRAPHRAG_INVESTIGATION_ERROR',
      summary: 'The GraphRAG comparison failed.',
      data: { runId: '', persisted: false, mode: input.mode ?? 'standard', indexFingerprint: '', budget: emptyGraphRagBudget(), plans: [] },
      evidence: [],
      diagnostics: [{ severity: 'error', code: 'GRAPHRAG_INVESTIGATION_ERROR', message }],
      truncated: false,
      retryable: false,
    };
  }
}

/** Projects a local trace into an MCP-safe result without code snippets or the query text. */
function toGraphRagInvestigationData(trace: DetectiveTrace): GraphRagInvestigationData {
  return {
    runId: trace.id,
    persisted: false,
    mode: trace.mode,
    indexFingerprint: trace.indexFingerprint,
    budget: { ...trace.budget },
    plans: trace.plans.map((plan) => ({
      plan: plan.plan,
      eligible: plan.eligible,
      ...(plan.reason === undefined ? {} : { reason: plan.reason }),
      selectedPaths: [...plan.selectedPaths],
      selectedEvidence: plan.selectedEvidence.map((item) => ({ ...item, relations: [...item.relations] })),
      branches: plan.branches.map((branch) => ({ ...branch })),
      elapsedMs: plan.elapsedMs,
      metrics: {
        ...plan.metrics,
        marginalEvidence: plan.metrics.marginalEvidence.map((hop) => ({ ...hop })),
      },
      quality: { ...plan.quality },
      recommendation: { ...plan.recommendation },
    })),
  };
}

/** Gives an error result an explicit zero budget rather than pretending a comparison ran. */
function emptyGraphRagBudget(): GraphRagInvestigationData['budget'] {
  return { maxSeeds: 0, maxDepth: 0, maxNodes: 0, maxRelations: 0, maxChunks: 0, maxEstimatedTokens: 0 };
}

function toCodebaseSearchData(result: GraphRagSearchResult): CodebaseSearchData {
  if (result.status === 'abstained') {
    return { query: result.query, ...(result.clarification === undefined ? {} : { clarification: result.clarification }),
    recoveredWithContext: false, abstentionReason: result.reason, unknownTerms: [...result.unknownTerms], ignoredModifiers: [...result.ignoredModifiers], files: [],
      ...(result.provenance === undefined ? {} : { provenance: result.provenance }),
      retrieval: toToolRetrievalStrategy(result.strategy),
    };
  }
  return { query: result.query, ...(result.clarification === undefined ? {} : { clarification: result.clarification }),
    recoveredWithContext: result.recoveredWithContext, unknownTerms: [], ignoredModifiers: [...result.ignoredModifiers],
    files: result.files.map((file) => ({ path: file.filePath, origin: file.origin, evidence: file.evidence, score: file.score, relations: [...file.relations], imports: [...file.imports],
      chunks: file.chunks.map((chunk) => ({ type: chunk.type, content: chunk.content,
        startLine: chunk.metadata.startLine, endLine: chunk.metadata.endLine,
        ...(chunk.metadata.className === undefined ? {} : { className: chunk.metadata.className }),
        ...(chunk.metadata.methodName === undefined ? {} : { methodName: chunk.metadata.methodName }),
        ...(chunk.metadata.artifactKind === undefined ? {} : { artifactKind: chunk.metadata.artifactKind }) })) })),
    ...(result.provenance === undefined ? {} : { provenance: result.provenance }),
    retrieval: toToolRetrievalStrategy(result.strategy),
  };
}

/** Copies readonly planner facts into the mutable arrays required by the validated tool result. */
function toToolRetrievalStrategy(
  strategy: GraphRagStrategy,
): NonNullable<CodebaseSearchData['retrieval']> {
  return {
    ...strategy,
    marginalEvidence: strategy.marginalEvidence.map((hop) => ({ ...hop })),
  };
}

/** Builds a schema-valid no-work strategy for index-unavailable and error results. */
function emptyRetrievalStrategy(): NonNullable<CodebaseSearchData['retrieval']> {
  return {
    policy: 'balanced-v1', plan: 'hybrid', depthReached: 0, nodesVisited: 0,
    relationsInspected: 0, stopReason: 'not-applicable', marginalEvidence: [],
    discardedBranches: 0, estimatedTokens: 0, elapsedMs: 0,
    readiness: {
      dependency: { ready: false, reason: 'Retrieval did not run.', pendingFiles: 0 },
      nest: { ready: false, reason: 'Retrieval did not run.', pendingFiles: 0 },
    },
    recommendation: { state: 'clarify', reason: 'Retrieval did not run.' },
  };
}

/** Translates a structured GraphRAG recommendation into the legacy string field. */
function recommendationNextAction(
  recommendation: NonNullable<CodebaseSearchData['retrieval']>['recommendation'],
): string | undefined {
  if (recommendation.state !== 'follow-up' || recommendation.tool === undefined) return undefined;
  if (recommendation.tool === 'query_dependency_graph') {
    return `Call query_dependency_graph for ${recommendation.subject ?? 'the grounded file'} if relationship detail is needed.`;
  }
  return `Call query_nest_graph for ${recommendation.subject ?? 'the grounded symbol'} if runtime wiring detail is needed.`;
}
