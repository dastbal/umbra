/**
 * @module GraphRAG
 *
 * Deterministic, bounded graph-assisted retrieval. The module deliberately
 * contains no chat-model dependency: hybrid search finds grounded seeds and
 * SQLite follows typed relations to additional inspectable source evidence.
 */

import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type Database from 'better-sqlite3';

import { loadAgentConfig, retrievalPolicySchema, type RetrievalPolicyId } from '../config/agent-config';
import { setConfiguredRetrievalPolicy } from '../config/agent-config-writer';
import { agentPath } from '../config/agent-directory';
import { runtimeRoot } from '../config/runtime-root';
import { AgentDB } from '../state/db';
import type { ChunkMetadata, ProcessedChunk } from '../types';
import { inspectDependencyGraphReadiness } from './dependency-graph-store';
import type { RetrievalEvidence } from './hybrid-ranking';
import { readIndexStamp } from './index-stamp';
import { findBindingsForToken, findInjectionsForToken } from './nest-graph-store';
import {
  formatRetrievalContextForLLM,
  type RetrievalContextResult,
  type RetrievalFileContext,
  type RetrievalProvenance,
  RetrieverService,
} from './retriever';
import type { PendingRetrievalAlias } from './retrieval-memory';
import { scoreCase, type RetrievalCorpusCase } from './retrieval-metrics';
import { renderSkeletonForContext } from './skeleton-render';

/** Stable plans which can be selected without an LLM. */
export const graphRagPlanIds = [
  'hybrid',
  'dependency-1',
  'dependency-2',
  'nest',
  'combined',
] as const;

/** One deterministic retrieval plan. */
export type GraphRagPlanId = (typeof graphRagPlanIds)[number];

/** How much graph work one plan is allowed to perform. */
export interface GraphRagBudget {
  /** Maximum grounded hybrid files used as graph traversal seeds. */
  readonly maxSeeds: number;
  /** Maximum number of relationship hops. */
  readonly maxDepth: number;
  /** Maximum distinct graph nodes, including semantic seeds. */
  readonly maxNodes: number;
  /** Maximum relationship rows read from SQLite. */
  readonly maxRelations: number;
  /** Maximum code chunks placed in the final context. */
  readonly maxChunks: number;
  /** Operator-visible conservative estimate of selected context size. */
  readonly maxEstimatedTokens: number;
}

/** Standard policy budget used by production and ordinary Detective runs. */
export const STANDARD_GRAPH_RAG_BUDGET: GraphRagBudget = {
  maxSeeds: 4,
  maxDepth: 2,
  maxNodes: 24,
  maxRelations: 48,
  maxChunks: 8,
  maxEstimatedTokens: 8_000,
};

/** Expanded local-only budget used by `/detective deep`. */
export const DEEP_GRAPH_RAG_BUDGET: GraphRagBudget = {
  maxSeeds: 4,
  maxDepth: 3,
  maxNodes: 48,
  maxRelations: 96,
  maxChunks: 12,
  maxEstimatedTokens: 14_000,
};

/** A graph projection's current safety state. */
export interface GraphProjectionReadiness {
  /** Whether traversal may use this projection. */
  readonly ready: boolean;
  /** Why the projection is ready or unavailable. */
  readonly reason: string;
  /** Number of derived rows that need a fresh source scan. */
  readonly pendingFiles: number;
}

/** Both typed graph projections needed by the planner. */
export interface GraphRagReadiness {
  /** File dependency projection status. */
  readonly dependency: GraphProjectionReadiness;
  /** NestJS binding and injection projection status. */
  readonly nest: GraphProjectionReadiness;
}

/** One code file selected for model-facing GraphRAG context. */
export interface GraphRagFileContext {
  /** Repository-relative path. */
  readonly filePath: string;
  /** How the file was reached. */
  readonly origin: 'seed' | 'graph';
  /** Hybrid evidence for a seed, or `graph` for a typed relationship route. */
  readonly evidence: RetrievalEvidence | 'graph';
  /** Code chunks selected under the hard context ceiling. */
  readonly chunks: readonly ProcessedChunk[];
  /** Direct imports, when this file owns dependency rows. */
  readonly imports: readonly string[];
  /** Renderable source skeleton, when indexing extracted one. */
  readonly skeleton?: string | null;
  /** Deterministic rank used only to order graph-routed files. */
  readonly score: number;
  /** Typed relationships that justified this graph-routed file. */
  readonly relations: readonly string[];
}

/** Machine-readable follow-up for a caller that can use Umbra's other tools. */
export interface GraphRagRecommendation {
  /** Whether the available evidence is enough for the caller to reason over. */
  readonly state: 'sufficient' | 'follow-up' | 'clarify';
  /** Read-only MCP tool most likely to add useful evidence, when any. */
  readonly tool?: 'query_dependency_graph' | 'query_nest_graph';
  /** Safe argument to offer to the caller, never a filesystem path outside the repository. */
  readonly subject?: string;
  /** Human-readable reason for this recommendation. */
  readonly reason: string;
}

/** The deterministic reason graph expansion stopped. */
export type GraphTraversalStopReason =
  | 'not-applicable'
  | 'abstained'
  | 'no-seeds'
  | 'marginal-evidence'
  | 'depth-budget'
  | 'relation-budget'
  | 'node-budget';

/** Per-hop proof that another graph level did or did not add usable source evidence. */
export interface GraphRagMarginalEvidence {
  /** One-based graph hop examined from the hybrid seeds. */
  readonly depth: number;
  /** Number of graph nodes expanded at this hop. */
  readonly frontierNodes: number;
  /** Relationship rows actually inspected at this hop. */
  readonly relationsInspected: number;
  /** New indexed source files admitted as inspectable evidence. */
  readonly novelEvidence: number;
  /** Branches rejected at this hop. */
  readonly discardedBranches: number;
}

/** Summary of one deterministic plan run. */
export interface GraphRagStrategy {
  /** Code-defined policy requested by the caller. */
  readonly policy: RetrievalPolicyId;
  /** Plan selected by policy and graph readiness. */
  readonly plan: GraphRagPlanId;
  /** Deepest relationship hop actually reached. */
  readonly depthReached: number;
  /** Distinct nodes visited, including hybrid seeds. */
  readonly nodesVisited: number;
  /** Relationship rows examined before budget or marginal-evidence stopping. */
  readonly relationsInspected: number;
  /** Deterministic proof for why expansion ended. */
  readonly stopReason: GraphTraversalStopReason;
  /** Evidence gained at every visited hop. */
  readonly marginalEvidence: readonly GraphRagMarginalEvidence[];
  /** Paths accepted into final context. */
  readonly selectedPaths: readonly string[];
  /** Graph branches skipped due to budget, duplication, or absent chunks. */
  readonly discardedBranches: number;
  /** Approximate selected source-context size. */
  readonly estimatedTokens: number;
  /** Time spent in deterministic planning after hybrid seed retrieval. */
  readonly elapsedMs: number;
  /** Independently verified relationship-projection state. */
  readonly readiness: GraphRagReadiness;
  /** The smallest useful next action for an external assistant. */
  readonly recommendation: GraphRagRecommendation;
}

/** A search result that preserves the original hybrid abstention contract. */
export type GraphRagSearchResult =
  | {
      readonly status: 'success';
      readonly query: string;
      readonly clarification?: string;
      readonly recoveredWithContext: boolean;
      readonly ignoredModifiers: readonly string[];
      readonly droppedTerms: readonly string[];
      readonly files: readonly GraphRagFileContext[];
      readonly provenance?: RetrievalProvenance;
      readonly strategy: GraphRagStrategy;
      readonly learningCandidate?: PendingRetrievalAlias;
    }
  | {
      readonly status: 'abstained';
      readonly query: string;
      readonly clarification?: string;
      readonly reason: 'unknown_terms' | 'ungrounded';
      readonly unknownTerms: readonly string[];
      readonly ignoredModifiers: readonly string[];
      readonly provenance?: RetrievalProvenance;
      readonly strategy: GraphRagStrategy;
    };

/** A branch considered during one graph traversal. Source code never enters this record. */
export interface GraphRagBranch {
  /** Source graph node. */
  readonly from: string;
  /** Target graph node. */
  readonly to: string;
  /** Relationship type that connects the two nodes. */
  readonly relation: string;
  /** Hop at which the relation was considered. */
  readonly depth: number;
  /** Why this branch was accepted or discarded. */
  readonly outcome: 'accepted' | 'duplicate' | 'budget' | 'no-chunks';
}

/** Privacy-scoped result of a Detective comparison. */
export interface DetectiveTrace {
  /** Stable trace schema version. */
  readonly schemaVersion: 1;
  /** Opaque local replay identifier. */
  readonly id: string;
  /** When the experiment completed. */
  readonly createdAt: string;
  /** Operator's question, intentionally retained only in local Detective storage. */
  readonly query: string;
  /** Strict identity of the index this experiment observed. */
  readonly indexFingerprint: string;
  /** Whether the ordinary or expanded local budget was used. */
  readonly mode: 'standard' | 'deep';
  /** Fixed ceilings that make every plan's resource use interpretable. */
  readonly budget: GraphRagBudget;
  /** Every eligible plan compared from the same hybrid seed lookup. */
  readonly plans: readonly DetectivePlanTrace[];
}

/** Trace-safe facts about one plan, without code or model output. */
export interface DetectivePlanTrace {
  /** Plan under test. */
  readonly plan: GraphRagPlanId;
  /** Whether graph readiness allowed the plan to run. */
  readonly eligible: boolean;
  /** Human-readable reason for ineligibility or outcome. */
  readonly reason?: string;
  /** Paths selected as evidence, never their source contents. */
  readonly selectedPaths: readonly string[];
  /** Source-free ranking facts for every selected evidence file. */
  readonly selectedEvidence: readonly DetectiveSelectedEvidence[];
  /** Branch ledger used to explain graph work. */
  readonly branches: readonly GraphRagBranch[];
  /** Measured plan time. */
  readonly elapsedMs: number;
  /** Budget and evidence counters. */
  readonly metrics: Pick<GraphRagStrategy,
    'depthReached' | 'nodesVisited' | 'relationsInspected' | 'stopReason' | 'marginalEvidence' |
    'discardedBranches' | 'estimatedTokens'>;
  /** Quality only when the free-text question has an explicit corpus oracle. */
  readonly quality: DetectiveQuality;
  /** The deterministic recommendation this plan produced. */
  readonly recommendation: GraphRagRecommendation;
}

/** Honest quality facts for one plan; free-form questions deliberately have no oracle. */
export interface DetectiveQuality {
  /** Matched corpus id, absent when this was an exploratory question. */
  readonly corpusCaseId?: string;
  /** Number of labelled cases in this trace: zero or one. */
  readonly sampleSize: 0 | 1;
  /** Whether the top path matched the labelled expectation. */
  readonly hitAt1?: number;
  /** Reciprocal rank against the labelled expectation. */
  readonly mrr?: number;
  /** Positive corpus case where retrieval returned no source. */
  readonly falseAbstention?: boolean;
  /** Negative corpus case where retrieval correctly abstained. */
  readonly correctAbstention?: boolean;
}

/** Trace-safe rank and route facts for one selected evidence file. */
export interface DetectiveSelectedEvidence {
  /** Repository-relative path. */
  readonly path: string;
  /** Whether hybrid retrieval seeded the file or the graph routed to it. */
  readonly origin: 'seed' | 'graph';
  /** Deterministic selection score, not a probability. */
  readonly score: number;
  /** Typed graph routes; empty for hybrid seeds. */
  readonly relations: readonly string[];
}

/** A replay outcome, deliberately refusing an invalid comparison. */
export interface DetectiveReplayResult {
  /** Original local experiment. */
  readonly previous: DetectiveTrace;
  /** Newly executed experiment. */
  readonly current: DetectiveTrace;
  /** Whether a direct metric delta is honest. */
  readonly comparable: boolean;
  /** Why no comparison was produced, when the corpus changed. */
  readonly reason?: string;
}

/** Result of an explicit local production-policy promotion. */
export interface RetrievalPolicyPromotion {
  /** Whether configuration was successfully written. */
  readonly promoted: boolean;
  /** Operator-selected policy. */
  readonly policy: RetrievalPolicyId;
  /** Latest compatible Detective trace used as evidence. */
  readonly trace?: DetectiveTrace;
  /** Safe explanation when a promotion could not happen. */
  readonly reason?: string;
}

interface PreparedSearch {
  readonly base: RetrievalContextResult;
  readonly readiness: GraphRagReadiness;
}

interface TraversalResult {
  readonly candidates: readonly TraversalCandidate[];
  readonly branches: readonly GraphRagBranch[];
  readonly depthReached: number;
  readonly relationsInspected: number;
  readonly stopReason: GraphTraversalStopReason;
  readonly marginalEvidence: readonly GraphRagMarginalEvidence[];
  readonly discardedBranches: number;
  readonly nodesVisited: number;
}

interface TraversalCandidate {
  readonly path: string;
  readonly score: number;
  readonly relations: readonly string[];
}

interface QueueNode {
  readonly path: string;
  readonly score: number;
}

/** One plan execution, retaining the same traversal that produced its answer. */
interface PlanExecution {
  /** Model-facing result using grounded source evidence. */
  readonly result: GraphRagSearchResult;
  /** Source-free traversal ledger for Detective only. */
  readonly traversal: TraversalResult;
}

interface DependencyRow {
  readonly source: string;
  readonly target: string;
  readonly relation: string;
}

interface ChunkRow {
  readonly id: string;
  readonly file_path: string;
  readonly chunk_type: string;
  readonly content: string;
  readonly metadata: string;
  readonly skeleton_signature: string | null;
}

const DEFAULT_RETRIEVAL_POLICY: RetrievalPolicyId = 'balanced-v1';

const RELATION_SCORES: Readonly<Record<string, number>> = {
  're-export': 0.9,
  injects: 0.9,
  provider: 0.9,
  export: 0.85,
  import: 0.75,
  extends: 0.75,
  implements: 0.7,
  require: 0.65,
  'dynamic-import': 0.65,
  module: 0.65,
};

/**
 * Runs production GraphRAG, local Detective experiments, and replay-safe
 * policy promotion from one deterministic kernel.
 */
export class GraphRagService {
  private readonly db: Database.Database;
  private readonly rootDir: string;

  /**
   * @param retriever - Hybrid retriever whose one lookup becomes shared seeds.
   * @param db - SQLite graph and source-evidence store.
   * @param rootDir - Root that owns local Detective state and policy.
   */
  constructor(
    private readonly retriever: RetrieverService = new RetrieverService(),
    db: Database.Database = AgentDB.getInstance(),
    rootDir: string = runtimeRoot(),
  ) {
    this.db = db;
    this.rootDir = rootDir;
  }

  /**
   * Retrieves source evidence with the manually approved local policy.
   *
   * @param query - Natural-language repository question.
   * @param context - Optional existing one-time hybrid clarification.
   * @returns Grounded source context and a compact deterministic strategy.
   */
  public async search(query: string, context?: string): Promise<GraphRagSearchResult> {
    const prepared = await this.prepare(query, context);
    const policy = this.configuredPolicy();
    return this.executePlan(prepared, policy, this.planForPolicy(policy, prepared), STANDARD_GRAPH_RAG_BUDGET).result;
  }

  /**
   * Compares every graph-ready plan against one shared hybrid seed lookup.
   *
   * @param query - Operator question retained only in the local trace.
   * @param mode - Standard or expanded bounded Detective budget.
   * @returns Persisted local comparison trace.
   */
  public async investigate(
    query: string,
    mode: 'standard' | 'deep' = 'standard',
  ): Promise<DetectiveTrace> {
    return this.runInvestigation(query, mode, true);
  }

  /**
   * Compares plans for a read-only caller without retaining the caller's question.
   *
   * @param query - Natural-language repository question.
   * @param mode - Standard or expanded bounded budget.
   * @returns Source-free comparison facts that are not persisted for replay.
   */
  public async compare(
    query: string,
    mode: 'standard' | 'deep' = 'standard',
  ): Promise<DetectiveTrace> {
    return this.runInvestigation(query, mode, false);
  }

  /** Runs one Detective comparison and persists it only for the local CLI workflow. */
  private async runInvestigation(
    query: string,
    mode: 'standard' | 'deep',
    persist: boolean,
  ): Promise<DetectiveTrace> {
    const prepared = await this.prepare(query);
    const budget = mode === 'deep' ? DEEP_GRAPH_RAG_BUDGET : STANDARD_GRAPH_RAG_BUDGET;
    const plans = graphRagPlanIds.map((plan) => this.tracePlan(prepared, plan, budget));
    const resolvedPlans = await Promise.all(plans);
    const trace: DetectiveTrace = {
      schemaVersion: 1,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      query,
      indexFingerprint: this.indexFingerprint(),
      mode,
      budget,
      plans: resolvedPlans,
    };
    if (persist) this.writeTrace(trace);
    return trace;
  }

  /**
   * Re-executes a local experiment and compares only an identical indexed corpus.
   *
   * @param traceId - Existing local Detective trace identifier.
   * @returns Current trace plus a compatibility decision.
   */
  public async replay(traceId: string): Promise<DetectiveReplayResult> {
    const previous = this.readTrace(traceId);
    const current = await this.investigate(previous.query, previous.mode);
    if (previous.indexFingerprint !== current.indexFingerprint) {
      return {
        previous,
        current,
        comparable: false,
        reason: 'The index fingerprint changed; this is a new experiment, not a direct replay.',
      };
    }
    return { previous, current, comparable: true };
  }

  /**
   * Saves a human-approved, code-defined policy after validating compatible evidence.
   *
   * @param policyInput - Policy identifier typed by the operator.
   * @returns Promotion result; no policy changes when evidence is absent or stale.
   */
  public promote(policyInput: string): RetrievalPolicyPromotion {
    const parsed = retrievalPolicySchema.safeParse(policyInput);
    if (!parsed.success) {
      return { promoted: false, policy: DEFAULT_RETRIEVAL_POLICY, reason: 'Unknown retrieval policy.' };
    }
    const policy = parsed.data;
    const trace = this.latestCompatibleTrace();
    if (trace === undefined) {
      return {
        promoted: false,
        policy,
        reason: 'No compatible Detective trace exists for the current index.',
      };
    }
    const expectedPlan = this.planForPolicy(policy, {
      base: this.emptyAbstention(trace.query),
      readiness: this.readiness(),
    });
    const evidence = trace.plans.find((plan) => plan.plan === expectedPlan && plan.eligible);
    if (evidence === undefined) {
      return {
        promoted: false,
        policy,
        trace,
        reason: `The latest compatible trace did not run ${expectedPlan}.`,
      };
    }
    const write = setConfiguredRetrievalPolicy(this.rootDir, policy);
    return write.saved
      ? { promoted: true, policy, trace }
      : { promoted: false, policy, trace, reason: write.reason ?? 'The local policy could not be saved.' };
  }

  /** Prepares a single hybrid seed lookup shared by all eligible graph plans. */
  private async prepare(query: string, context?: string): Promise<PreparedSearch> {
    return { base: await this.retriever.getContext(query, context), readiness: this.readiness() };
  }

  /** Reads the explicit local policy without materialising a default into disk. */
  private configuredPolicy(): RetrievalPolicyId {
    return loadAgentConfig(this.rootDir).rag.retrievalPolicy ?? DEFAULT_RETRIEVAL_POLICY;
  }

  /** Selects one production plan without calling a language model. */
  private planForPolicy(policy: RetrievalPolicyId, prepared: PreparedSearch): GraphRagPlanId {
    const direct: Partial<Record<RetrievalPolicyId, GraphRagPlanId>> = {
      'hybrid-v1': 'hybrid',
      'dependency-1-v1': 'dependency-1',
      'dependency-2-v1': 'dependency-2',
      'nest-v1': 'nest',
      'combined-v1': 'combined',
    };
    const requested = direct[policy];
    if (requested !== undefined) return this.isEligible(requested, prepared.readiness) ? requested : 'hybrid';

    if (prepared.base.status === 'abstained') return 'hybrid';
    const asksForWiring = /\b(provider|inject(?:ion)?|module|token|nest|forwardref)\b/i.test(prepared.base.query);
    if (asksForWiring && this.isEligible('combined', prepared.readiness)) return 'combined';
    if (this.isEligible('dependency-2', prepared.readiness)) return 'dependency-2';
    if (this.isEligible('nest', prepared.readiness)) return 'nest';
    return 'hybrid';
  }

  /** Runs one plan once, preserving its traversal ledger for optional Detective projection. */
  private executePlan(
    prepared: PreparedSearch,
    policy: RetrievalPolicyId,
    plan: GraphRagPlanId,
    budget: GraphRagBudget,
  ): PlanExecution {
    const startedAt = Date.now();
    if (prepared.base.status === 'abstained') {
      const strategy = this.abstentionStrategy(policy, plan, prepared.readiness, Date.now() - startedAt);
      return { result: { ...prepared.base, strategy }, traversal: this.emptyTraversal(0, 'abstained') };
    }

    const seeds = this.seedFiles(prepared.base.files, budget.maxSeeds);
    const traversalBudget = this.budgetForPlan(plan, budget);
    const traversal = this.isEligible(plan, prepared.readiness)
      ? this.traverse(plan, seeds.map((seed) => seed.filePath), traversalBudget)
      : this.emptyTraversal(seeds.length, 'not-applicable');
    const files = this.selectFiles(seeds, traversal.candidates, budget);
    const strategy: GraphRagStrategy = {
      policy,
      plan,
      depthReached: traversal.depthReached,
      nodesVisited: traversal.nodesVisited,
      relationsInspected: traversal.relationsInspected,
      stopReason: traversal.stopReason,
      marginalEvidence: traversal.marginalEvidence,
      selectedPaths: files.map((file) => file.filePath),
      discardedBranches: traversal.discardedBranches,
      estimatedTokens: estimateTokens(files),
      elapsedMs: Date.now() - startedAt,
      readiness: prepared.readiness,
      recommendation: this.recommend(plan, prepared.readiness, files, traversal),
    };
    return {
      traversal,
      result: {
        status: 'success',
        query: prepared.base.query,
        ...(prepared.base.clarification === undefined ? {} : { clarification: prepared.base.clarification }),
        recoveredWithContext: prepared.base.recoveredWithContext,
        ignoredModifiers: prepared.base.ignoredModifiers,
        droppedTerms: prepared.base.droppedTerms,
        files,
        ...(prepared.base.provenance === undefined ? {} : { provenance: prepared.base.provenance }),
        strategy,
        ...(this.retriever.learningCandidate === undefined ? {} : { learningCandidate: this.retriever.learningCandidate }),
      },
    };
  }

  /** Narrows a shared mode budget when a plan promises a stricter semantic limit. */
  private budgetForPlan(plan: GraphRagPlanId, budget: GraphRagBudget): GraphRagBudget {
    return plan === 'dependency-1'
      ? { ...budget, maxDepth: Math.min(budget.maxDepth, 1) }
      : budget;
  }

  /** Converts one plan run into privacy-safe Detective facts. */
  private async tracePlan(
    prepared: PreparedSearch,
    plan: GraphRagPlanId,
    budget: GraphRagBudget,
  ): Promise<DetectivePlanTrace> {
    const eligible = this.isEligible(plan, prepared.readiness);
    const execution = this.executePlan(prepared, 'balanced-v1', plan, budget);
    const { result, traversal } = execution;
    return {
      plan,
      eligible,
      ...(eligible ? {} : { reason: this.ineligibilityReason(plan, prepared.readiness) }),
      selectedPaths: result.status === 'success' ? result.strategy.selectedPaths : [],
      selectedEvidence: result.status === 'success'
        ? result.files.map((file) => ({
            path: file.filePath,
            origin: file.origin,
            score: file.score,
            relations: file.relations,
          }))
        : [],
      branches: traversal.branches,
      elapsedMs: result.strategy.elapsedMs,
      metrics: {
        depthReached: result.strategy.depthReached,
        nodesVisited: result.strategy.nodesVisited,
        relationsInspected: result.strategy.relationsInspected,
        stopReason: result.strategy.stopReason,
        marginalEvidence: result.strategy.marginalEvidence,
        discardedBranches: result.strategy.discardedBranches,
        estimatedTokens: result.strategy.estimatedTokens,
      },
      quality: this.qualityFor(prepared.base.query, result),
      recommendation: result.strategy.recommendation,
    };
  }

  /** Reports graph readiness separately from semantic index readiness. */
  private readiness(): GraphRagReadiness {
    const dependency = inspectDependencyGraphReadiness(this.db);
    return { dependency, nest: this.inspectNestReadiness() };
  }

  /** Validates whether the NestJS projection covers every current indexed file. */
  private inspectNestReadiness(): GraphProjectionReadiness {
    const indexed = this.db.prepare(
      "SELECT COUNT(*) AS count FROM file_registry WHERE index_state = 'indexed'",
    ).get() as { count: number };
    if (indexed.count === 0) {
      return { ready: false, reason: 'No indexed source files are available.', pendingFiles: 0 };
    }
    const pending = this.db.prepare(`
      SELECT COUNT(*) AS count
        FROM file_registry r
        LEFT JOIN nest_scan s ON s.file_path = r.path
       WHERE r.index_state = 'indexed' AND (s.hash IS NULL OR s.hash <> r.hash)
    `).get() as { count: number };
    return pending.count === 0
      ? { ready: true, reason: 'NestJS wiring covers the indexed source corpus.', pendingFiles: 0 }
      : {
          ready: false,
          reason: `${pending.count} indexed source file(s) lack a current NestJS scan.`,
          pendingFiles: pending.count,
        };
  }

  /** Determines whether one plan may use only complete relationship projections. */
  private isEligible(plan: GraphRagPlanId, readiness: GraphRagReadiness): boolean {
    if (plan === 'hybrid') return true;
    if (plan === 'dependency-1' || plan === 'dependency-2') return readiness.dependency.ready;
    if (plan === 'nest') return readiness.nest.ready;
    return readiness.dependency.ready && readiness.nest.ready;
  }

  /** Explains ineligibility rather than treating it as a graph with zero results. */
  private ineligibilityReason(plan: GraphRagPlanId, readiness: GraphRagReadiness): string {
    if (plan === 'dependency-1' || plan === 'dependency-2') return readiness.dependency.reason;
    if (plan === 'nest') return readiness.nest.reason;
    if (plan === 'combined') return !readiness.dependency.ready
      ? readiness.dependency.reason
      : readiness.nest.reason;
    return 'Hybrid retrieval is always eligible.';
  }

  /** Keeps the original grounded hybrid files as stable graph seeds. */
  private seedFiles(files: readonly RetrievalFileContext[], maxSeeds: number): readonly GraphRagFileContext[] {
    return files.slice(0, maxSeeds).map((file) => ({
      filePath: file.filePath,
      origin: 'seed',
      evidence: file.evidence,
      chunks: file.chunks,
      imports: file.imports,
      ...(file.skeleton === undefined ? {} : { skeleton: file.skeleton }),
      score: 1,
      relations: [],
    }));
  }

  /** Traverses only relationships allowed by the selected plan and hard budget. */
  private traverse(
    plan: GraphRagPlanId,
    seedPaths: readonly string[],
    budget: GraphRagBudget,
  ): TraversalResult {
    if (plan === 'hybrid') return this.emptyTraversal(seedPaths.length, 'not-applicable');
    if (seedPaths.length === 0) return this.emptyTraversal(0, 'no-seeds');
    let frontier: QueueNode[] = seedPaths.map((path) => ({ path, score: 1 }));
    const seen = new Set(seedPaths);
    const candidates = new Map<string, { score: number; relations: Set<string> }>();
    const branches: GraphRagBranch[] = [];
    const marginalEvidence: GraphRagMarginalEvidence[] = [];
    let depthReached = 0;
    let relationsInspected = 0;
    let discardedBranches = 0;
    let stopReason: GraphTraversalStopReason | undefined;

    for (let depth = 1; depth <= budget.maxDepth && frontier.length > 0; depth += 1) {
      const nextFrontier: QueueNode[] = [];
      const frontierNodes = frontier.length;
      const relationCountAtStart = relationsInspected;
      const discardedAtStart = discardedBranches;

      traverseFrontier: for (const current of frontier) {
        const edges = this.edgesFor(plan, current.path);
        for (const edge of edges) {
          if (relationsInspected >= budget.maxRelations) {
            branches.push({ from: current.path, to: edge.to, relation: edge.relation, depth, outcome: 'budget' });
            discardedBranches += 1;
            stopReason = 'relation-budget';
            break traverseFrontier;
          }
          relationsInspected += 1;
          if (seen.has(edge.to)) {
            branches.push({ from: current.path, to: edge.to, relation: edge.relation, depth, outcome: 'duplicate' });
            discardedBranches += 1;
            continue;
          }
          if (seen.size >= budget.maxNodes) {
            branches.push({ from: current.path, to: edge.to, relation: edge.relation, depth, outcome: 'budget' });
            discardedBranches += 1;
            stopReason = 'node-budget';
            break traverseFrontier;
          }
          const available = this.hasChunks(edge.to);
          if (!available) {
            branches.push({ from: current.path, to: edge.to, relation: edge.relation, depth, outcome: 'no-chunks' });
            discardedBranches += 1;
            continue;
          }
          seen.add(edge.to);
          const score = current.score * relationScore(edge.relation);
          const existing = candidates.get(edge.to);
          if (existing === undefined) candidates.set(edge.to, { score, relations: new Set([edge.relation]) });
          else {
            existing.score = Math.max(existing.score, score);
            existing.relations.add(edge.relation);
          }
          branches.push({ from: current.path, to: edge.to, relation: edge.relation, depth, outcome: 'accepted' });
          nextFrontier.push({ path: edge.to, score });
          depthReached = Math.max(depthReached, depth);
        }
      }
      marginalEvidence.push({
        depth,
        frontierNodes,
        relationsInspected: relationsInspected - relationCountAtStart,
        novelEvidence: nextFrontier.length,
        discardedBranches: discardedBranches - discardedAtStart,
      });
      if (stopReason !== undefined) break;
      if (nextFrontier.length === 0) {
        stopReason = 'marginal-evidence';
        break;
      }
      frontier = nextFrontier;
    }

    if (stopReason === undefined) stopReason = 'depth-budget';

    return {
      candidates: [...candidates.entries()]
        .map(([path, candidate]) => ({ path, score: candidate.score, relations: [...candidate.relations].sort() }))
        .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path)),
      branches,
      depthReached,
      relationsInspected,
      stopReason,
      marginalEvidence,
      discardedBranches,
      nodesVisited: seen.size,
    };
  }

  /** Produces typed deterministic neighbours for a single graph node. */
  private edgesFor(plan: GraphRagPlanId, filePath: string): readonly { to: string; relation: string }[] {
    const edges: { to: string; relation: string }[] = [];
    if (plan === 'dependency-1' || plan === 'dependency-2' || plan === 'combined') {
      const rows = this.db.prepare(
        'SELECT source, target, relation FROM dependency_graph WHERE source = ? OR target = ? ORDER BY relation, source, target',
      ).all(filePath, filePath) as DependencyRow[];
      for (const row of rows) {
        if (plan === 'dependency-1' && row.source !== filePath) continue;
        edges.push({ to: row.source === filePath ? row.target : row.source, relation: row.relation });
      }
    }
    if (plan === 'nest' || plan === 'combined') {
      for (const token of this.tokensForFile(filePath)) {
        for (const binding of findBindingsForToken(this.db, token)) {
          if (binding.filePath !== filePath) edges.push({ to: binding.filePath, relation: binding.kind });
        }
        for (const injection of findInjectionsForToken(this.db, token)) {
          if (injection.filePath !== filePath) edges.push({ to: injection.filePath, relation: 'injects' });
        }
      }
    }
    return edges.sort((left, right) => left.relation.localeCompare(right.relation) || left.to.localeCompare(right.to));
  }

  /** Reads only stored Nest tokens attached to one indexed source file. */
  private tokensForFile(filePath: string): readonly string[] {
    const bindings = this.db.prepare('SELECT token FROM nest_bindings WHERE file_path = ? ORDER BY token').all(filePath) as Array<{ token: string }>;
    const injections = this.db.prepare('SELECT token FROM nest_injections WHERE file_path = ? ORDER BY token').all(filePath) as Array<{ token: string }>;
    return [...new Set([...bindings, ...injections].map((row) => row.token))];
  }

  /** Returns one real stored NestJS token suitable for the Nest graph tool input. */
  private firstNestToken(files: readonly GraphRagFileContext[]): string | undefined {
    for (const file of files) {
      const token = this.tokensForFile(file.filePath)[0];
      if (token !== undefined) return token;
    }
    return undefined;
  }

  /** Checks source availability before accepting a graph node as evidence. */
  private hasChunks(filePath: string): boolean {
    return this.db.prepare('SELECT 1 FROM code_chunks WHERE file_path = ? LIMIT 1').get(filePath) !== undefined;
  }

  /** Loads bounded chunks for graph-routed source context. */
  private graphFile(filePath: string, score: number, relations: readonly string[], remainingChunks: number): GraphRagFileContext | undefined {
    if (remainingChunks <= 0) return undefined;
    const rows = this.db.prepare(`
      SELECT c.id, c.file_path, c.chunk_type, c.content, c.metadata, r.skeleton_signature
        FROM code_chunks c
        JOIN file_registry r ON r.path = c.file_path
       WHERE c.file_path = ?
       ORDER BY CASE c.chunk_type WHEN 'file' THEN 0 WHEN 'class_signature' THEN 1 ELSE 2 END, c.id
       LIMIT ?
    `).all(filePath, remainingChunks) as ChunkRow[];
    if (rows.length === 0) return undefined;
    const first = rows[0];
    return {
      filePath,
      origin: 'graph',
      evidence: 'graph',
      chunks: rows.map(toProcessedChunk),
      imports: this.directImports(filePath),
      ...(first.skeleton_signature === null ? {} : { skeleton: first.skeleton_signature }),
      score,
      relations,
    };
  }

  /** Adds graph-routed files only after the already-grounded hybrid seeds. */
  private selectFiles(
    seeds: readonly GraphRagFileContext[],
    candidates: readonly TraversalCandidate[],
    budget: GraphRagBudget,
  ): readonly GraphRagFileContext[] {
    const selected: GraphRagFileContext[] = [];
    let remainingChunks = budget.maxChunks;
    let remainingTokens = budget.maxEstimatedTokens;
    for (const seed of seeds) {
      const bounded = this.fitFileWithinBudget(seed, remainingChunks, remainingTokens);
      if (bounded === undefined) continue;
      selected.push(bounded);
      remainingChunks -= bounded.chunks.length;
      remainingTokens -= estimateTokens([bounded]);
    }
    for (const candidate of candidates) {
      if (remainingChunks <= 0 || remainingTokens <= 0) break;
      const file = this.graphFile(candidate.path, candidate.score, candidate.relations, remainingChunks);
      if (file === undefined) continue;
      const bounded = this.fitFileWithinBudget(file, remainingChunks, remainingTokens);
      if (bounded === undefined) continue;
      selected.push(bounded);
      remainingChunks -= bounded.chunks.length;
      remainingTokens -= estimateTokens([bounded]);
    }
    return selected;
  }

  /** Retains whole source chunks only while both context ceilings remain true. */
  private fitFileWithinBudget(
    file: GraphRagFileContext,
    remainingChunks: number,
    remainingTokens: number,
  ): GraphRagFileContext | undefined {
    const chunks: ProcessedChunk[] = [];
    let usedTokens = 0;
    for (const chunk of file.chunks) {
      const tokens = estimateChunkTokens(chunk);
      if (chunks.length >= remainingChunks || usedTokens + tokens > remainingTokens) break;
      chunks.push(chunk);
      usedTokens += tokens;
    }
    return chunks.length === 0 ? undefined : { ...file, chunks };
  }

  /** Reads direct file imports for consistent existing-context presentation. */
  private directImports(filePath: string): readonly string[] {
    return (this.db.prepare(
      'SELECT target FROM dependency_graph WHERE source = ? ORDER BY target',
    ).all(filePath) as Array<{ target: string }>).map((row) => row.target);
  }

  /** Provides a safe compact follow-up instead of silently issuing another tool call. */
  private recommend(
    plan: GraphRagPlanId,
    readiness: GraphRagReadiness,
    files: readonly GraphRagFileContext[],
    traversal: TraversalResult,
  ): GraphRagRecommendation {
    if (files.length === 0) {
      return { state: 'clarify', reason: 'No grounded source evidence was available; clarify with a repository symbol or path.' };
    }
    const graphFiles = files.filter((file) => file.origin === 'graph');
    if (graphFiles.length > 0) {
      return { state: 'sufficient', reason: 'Grounded seeds and bounded graph-routed source evidence are available.' };
    }
    const first = files[0]?.filePath;
    if (first !== undefined && readiness.dependency.ready && plan === 'hybrid') {
      return { state: 'follow-up', tool: 'query_dependency_graph', subject: first, reason: 'A grounded file was found; inspect its typed dependencies only if the question needs blast-radius context.' };
    }
    if (readiness.nest.ready && (plan === 'dependency-1' || plan === 'dependency-2')) {
      const token = this.firstNestToken(files);
      if (token !== undefined) {
        return { state: 'follow-up', tool: 'query_nest_graph', subject: token, reason: 'Dependency evidence is grounded; inspect this stored NestJS token only if runtime binding context is needed.' };
      }
    }
    return { state: 'sufficient', reason: traversal.relationsInspected === 0 ? 'Grounded hybrid evidence is sufficient without graph expansion.' : 'No additional graph-routed source evidence survived the bounded traversal.' };
  }

  /** Builds an abstention strategy without pretending graph expansion ran. */
  private abstentionStrategy(
    policy: RetrievalPolicyId,
    plan: GraphRagPlanId,
    readiness: GraphRagReadiness,
    elapsedMs: number,
  ): GraphRagStrategy {
    return {
      policy,
      plan,
      depthReached: 0,
      nodesVisited: 0,
      relationsInspected: 0,
      stopReason: 'abstained',
      marginalEvidence: [],
      selectedPaths: [],
      discardedBranches: 0,
      estimatedTokens: 0,
      elapsedMs,
      readiness,
      recommendation: { state: 'clarify', reason: 'Hybrid retrieval abstained before graph expansion; clarify with repository-backed terms.' },
    };
  }

  /** Returns a stable zero-work traversal for hybrid or unavailable plans. */
  private emptyTraversal(nodesVisited: number, stopReason: GraphTraversalStopReason): TraversalResult {
    return {
      candidates: [],
      branches: [],
      depthReached: 0,
      relationsInspected: 0,
      stopReason,
      marginalEvidence: [],
      discardedBranches: 0,
      nodesVisited,
    };
  }

  /** Creates a minimal abstention solely to resolve a direct policy's plan identifier. */
  private emptyAbstention(query: string): RetrievalContextResult {
    return { status: 'abstained', query, reason: 'ungrounded', unknownTerms: [], ignoredModifiers: [] };
  }

  /** Generates a corpus-sensitive fingerprint without retaining source contents. */
  private indexFingerprint(): string {
    const stamp = readIndexStamp(this.rootDir);
    const files = this.db.prepare('SELECT path, hash FROM file_registry ORDER BY path').all() as Array<{ path: string; hash: string }>;
    return createHash('sha256').update(JSON.stringify({
      stamp: stamp === undefined ? null : {
        provider: stamp.provider,
        model: stamp.model,
        dimensions: stamp.dimensions,
        indexedAt: stamp.indexedAt,
        status: stamp.status,
      },
      files,
    })).digest('hex');
  }

  /** Writes one explicit local Detective record atomically. */
  private writeTrace(trace: DetectiveTrace): void {
    const directory = this.traceDirectory();
    fs.mkdirSync(directory, { recursive: true });
    const target = path.join(directory, `${trace.id}.json`);
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(trace, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, target);
  }

  /** Reads and validates a trace selected by its opaque filename-safe identifier. */
  private readTrace(traceId: string): DetectiveTrace {
    if (!/^[0-9a-f-]{36}$/i.test(traceId)) throw new Error('Detective trace id is invalid.');
    const target = path.join(this.traceDirectory(), `${traceId}.json`);
    const parsed: unknown = JSON.parse(fs.readFileSync(target, 'utf8'));
    return parseDetectiveTrace(parsed);
  }

  /** Finds the most recent trace that refers to the active exact index fingerprint. */
  private latestCompatibleTrace(): DetectiveTrace | undefined {
    const directory = this.traceDirectory();
    if (!fs.existsSync(directory)) return undefined;
    const fingerprint = this.indexFingerprint();
    const traces = fs.readdirSync(directory)
      .filter((entry) => /^[0-9a-f-]{36}\.json$/i.test(entry))
      .map((entry) => parseDetectiveTrace(JSON.parse(fs.readFileSync(path.join(directory, entry), 'utf8')) as unknown))
      .filter((trace) => trace.indexFingerprint === fingerprint)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return traces[0];
  }

  /** Resolves the sole directory allowed to retain Detective questions. */
  private traceDirectory(): string {
    return agentPath(this.rootDir, 'detective');
  }

  /** Scores a plan only when the project provides an explicit expectation for its question. */
  private qualityFor(query: string, result: GraphRagSearchResult): DetectiveQuality {
    const corpusCase = this.corpusCaseFor(query);
    if (corpusCase === undefined) return { sampleSize: 0 };
    const paths = result.status === 'success' ? result.files.map((file) => file.filePath) : [];
    const outcome = scoreCase(corpusCase, paths, result.strategy.elapsedMs);
    const expected = corpusCase.expectedPaths;
    const hitAt1 = expected.length === 0
      ? (paths.length === 0 ? 1 : 0)
      : (paths[0] !== undefined && expected.some((path) => paths[0]!.endsWith(path)) ? 1 : 0);
    return {
      corpusCaseId: corpusCase.id,
      sampleSize: 1,
      hitAt1,
      mrr: outcome.reciprocalRank,
      falseAbstention: outcome.falseAbstention,
      correctAbstention: corpusCase.expectedPaths.length === 0 ? outcome.abstained : undefined,
    };
  }

  /** Reads one locally versioned retrieval oracle when the current project carries it. */
  private corpusCaseFor(query: string): RetrievalCorpusCase | undefined {
    const corpusPath = path.join(this.rootDir, 'docs', 'benchmarks', 'embedding-retrieval-corpus.json');
    if (!fs.existsSync(corpusPath)) return undefined;
    const parsed: unknown = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Retrieval benchmark corpus must be a JSON object.');
    }
    const queries = (parsed as Record<string, unknown>).queries;
    if (!Array.isArray(queries)) throw new Error('Retrieval benchmark corpus lacks queries.');
    for (const item of queries) {
      const corpusCase = parseCorpusCase(item);
      if (corpusCase.query.trim().toLocaleLowerCase() === query.trim().toLocaleLowerCase()) return corpusCase;
    }
    return undefined;
  }
}

/** Formats GraphRAG evidence for the local CLI agent without hiding graph provenance. */
export function formatGraphRagContextForLLM(result: GraphRagSearchResult): string {
  if (result.status === 'abstained') {
    return formatRetrievalContextForLLM({
      status: 'abstained',
      query: result.query,
      ...(result.clarification === undefined ? {} : { clarification: result.clarification }),
      reason: result.reason,
      unknownTerms: result.unknownTerms,
      ignoredModifiers: result.ignoredModifiers,
      ...(result.provenance === undefined ? {} : { provenance: result.provenance }),
    });
  }

  const lines = [
    '🔎 **GRAPHRAG ANALYSIS REPORT**',
    `Query: "${result.query}"`,
    'RETRIEVAL RECEIPT — preserve these identifiers exactly when reporting them. `policy` is the configured profile; `plan` is the plan actually executed. Never substitute one for the other.',
    `policy: ${result.strategy.policy}`,
    `plan: ${result.strategy.plan}`,
    `depthReached: ${result.strategy.depthReached}`,
    `nodesVisited: ${result.strategy.nodesVisited}`,
    `relationsInspected: ${result.strategy.relationsInspected}`,
    `stopReason: ${result.strategy.stopReason}`,
    '',
  ];
  for (const file of result.files) {
    lines.push('=================================================================');
    lines.push(`📂 **FILE:** ${file.filePath}`);
    lines.push(file.origin === 'seed'
      ? `🔎 **MATCH:** ${file.evidence}`
      : `🕸️ **GRAPH ROUTE:** ${file.relations.join(', ') || 'typed relation'}`);
    if (file.imports.length > 0) lines.push(`🔗 **DEPENDENCIES:** ${file.imports.slice(0, 5).join(', ')}`);
    const skeleton = renderSkeletonForContext(file.skeleton);
    if (skeleton !== undefined) lines.push(`🏗️ **FILE SKELETON:**\n${skeleton}`);
    lines.push('📝 **CODE SNIPPETS:**');
    for (const chunk of file.chunks) {
      lines.push(`--- [${chunk.metadata.methodName ?? 'Class Structure'}] ---`);
      lines.push(chunk.content.trim());
    }
    lines.push(`💡 **AGENT HINT:** read_file("${file.filePath}") for complete source.`);
    lines.push('=================================================================', '');
  }
  return lines.join('\n');
}

/** Computes a stable relation score; unknown future relation types remain useful but weak. */
function relationScore(relation: string): number {
  return RELATION_SCORES[relation] ?? 0.5;
}

/** Estimates source tokens conservatively without sending text to a tokenizer. */
function estimateTokens(files: readonly GraphRagFileContext[]): number {
  return files.reduce((total, file) => total + file.chunks.reduce(
    (fileTotal, chunk) => fileTotal + estimateChunkTokens(chunk),
    0,
  ), 0);
}

/** Gives a stable, provider-free upper-bound estimate for one source chunk. */
function estimateChunkTokens(chunk: ProcessedChunk): number {
  return Math.ceil(chunk.content.length / 4);
}

/** Converts an indexed SQLite row into a safely shaped code chunk. */
function toProcessedChunk(row: ChunkRow): ProcessedChunk {
  return {
    id: row.id,
    filePath: row.file_path,
    type: parseChunkType(row.chunk_type),
    content: row.content,
    metadata: parseChunkMetadata(row.metadata),
  };
}

/** Validates the closed chunk-type set while preserving a safe file-level fallback. */
function parseChunkType(value: string): ProcessedChunk['type'] {
  return value === 'method' || value === 'class_signature' || value === 'config' || value === 'file'
    ? value
    : 'file';
}

/** Parses only the known metadata fields needed by presentation. */
function parseChunkMetadata(raw: string): ChunkMetadata {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Indexed chunk metadata must be an object.');
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.startLine !== 'number' || typeof record.endLine !== 'number') {
    throw new Error('Indexed chunk metadata lacks source line boundaries.');
  }
  return {
    startLine: record.startLine,
    endLine: record.endLine,
    ...(typeof record.className === 'string' ? { className: record.className } : {}),
    ...(typeof record.methodName === 'string' ? { methodName: record.methodName } : {}),
    ...(typeof record.documentation === 'string' ? { documentation: record.documentation } : {}),
    ...(record.artifactKind === 'prisma-schema' ? { artifactKind: 'prisma-schema' as const } : {}),
  };
}

/** Validates a persisted trace before it becomes replay or promotion evidence. */
function parseDetectiveTrace(value: unknown): DetectiveTrace {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Detective trace must be a JSON object.');
  }
  const trace = value as Partial<DetectiveTrace>;
  if (
    trace.schemaVersion !== 1 ||
    typeof trace.id !== 'string' ||
    typeof trace.createdAt !== 'string' ||
    typeof trace.query !== 'string' ||
    typeof trace.indexFingerprint !== 'string' ||
    (trace.mode !== 'standard' && trace.mode !== 'deep') ||
    !Array.isArray(trace.plans)
  ) {
    throw new Error('Detective trace has an unsupported schema.');
  }
  return {
    ...trace,
    // v1 traces written before budget facts existed remain replayable. The mode
    // determines their fixed historic ceiling, so this is a deterministic
    // migration rather than a guessed measurement.
    budget: isGraphRagBudget((trace as { budget?: unknown }).budget)
      ? (trace as { budget: GraphRagBudget }).budget
      : trace.mode === 'deep' ? DEEP_GRAPH_RAG_BUDGET : STANDARD_GRAPH_RAG_BUDGET,
  } as DetectiveTrace;
}

/** Narrows persisted budget metadata before it becomes a replay display fact. */
function isGraphRagBudget(value: unknown): value is GraphRagBudget {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const budget = value as Record<string, unknown>;
  return [
    budget.maxSeeds,
    budget.maxDepth,
    budget.maxNodes,
    budget.maxRelations,
    budget.maxChunks,
    budget.maxEstimatedTokens,
  ].every((entry) => typeof entry === 'number' && Number.isFinite(entry) && entry >= 0);
}

/** Narrows one corpus JSON row before it is allowed to score a policy. */
function parseCorpusCase(value: unknown): RetrievalCorpusCase {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Retrieval benchmark corpus contains a non-object query.');
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== 'string' ||
    typeof record.split !== 'string' ||
    typeof record.query !== 'string' ||
    !Array.isArray(record.expectedPaths) ||
    !record.expectedPaths.every((item) => typeof item === 'string')
  ) {
    throw new Error('Retrieval benchmark corpus contains an invalid query.');
  }
  return {
    id: record.id,
    split: record.split,
    query: record.query,
    expectedPaths: record.expectedPaths,
    ...(record.unprovableByAbsence === true ? { unprovableByAbsence: true } : {}),
  };
}
