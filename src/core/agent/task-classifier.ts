import type { TaskComplexity } from './contracts';

/** Subagents that the interactive orchestrator may invoke for one user turn. */
export type OrchestrationSubagent = 'researcher' | 'coder' | 'verifier';

/**
 * Deterministic routing decision made before an interactive request enters the
 * LangGraph agent. It avoids spending implementation-model calls on questions
 * that can be answered directly, while preserving the full quality gate for
 * every request that can change code.
 */
export interface OrchestrationRoute {
  /** Size of the requested work. */
  complexity: TaskComplexity;
  /** Whether the request can change project files. */
  requiresImplementation: boolean;
  /** Ordered, mandatory specialists for this turn. */
  subagents: OrchestrationSubagent[];
}

const READ_ONLY_PATTERN = /\b(explain|describe|what is|what does|how does|why|analy[sz]e|audit|review|compare|show|list|explica|describe|qué es|qué hace|cómo funciona|por qué|analiza|audita|revisa|compara|muestra|lista)\b/i;
const GREETING_PATTERN = /^(hi|hello|hey( there)?|hola|buenas( tardes| noches| días)?|qué tal|cómo estás)[!?.\s]*$/i;
const IMPLEMENTATION_PATTERN = /\b(add|create|implement|build|fix|change|modify|update|refactor|rename|remove|delete|migrate|write|agrega|añade|crea|implementa|construye|corrige|cambia|modifica|actualiza|renombra|elimina|migra|escribe)\b/i;
const LARGE_PATTERN = /\b(module|feature|architecture|major|migration|database|prisma|typeorm|repository|endpoint|controller|ddd|multi[- ]file|refactor|módulo|funcionalidad|arquitectura|migración|base de datos|repositorio|controlador|multiarchivo)\b/i;

/**
 * Classifies one user request using transparent, conservative heuristics.
 *
 * The classifier never routes a potential code modification directly: all
 * write-capable requests retain Researcher, Coder, and Verifier. It only skips
 * those agents for clearly read-only requests.
 *
 * @param request - Raw interactive user request.
 * @returns The safe route the Supervisor must follow.
 */
export function classifyOrchestrationTask(request: string): OrchestrationRoute {
  const isImplementation = IMPLEMENTATION_PATTERN.test(request);

  if (!isImplementation && (READ_ONLY_PATTERN.test(request) || GREETING_PATTERN.test(request))) {
    return { complexity: 'small', requiresImplementation: false, subagents: [] };
  }

  if (LARGE_PATTERN.test(request)) {
    return {
      complexity: 'large',
      requiresImplementation: true,
      subagents: ['researcher', 'coder', 'verifier'],
    };
  }

  return {
    complexity: 'medium',
    requiresImplementation: true,
    subagents: ['researcher', 'coder', 'verifier'],
  };
}

/**
 * Adds a trusted routing envelope without changing the user's original text.
 * The envelope is consumed by the Supervisor prompt and remains in LangGraph
 * checkpoint history, making delegation choices auditable per session.
 *
 * @param route - Precomputed safe route.
 * @param request - Original user message.
 * @returns Prompt content sent to the interactive orchestrator.
 */
export function formatOrchestrationRoute(route: OrchestrationRoute, request: string): string {
  const subagents = route.subagents.length === 0
    ? 'none (answer with read-only tools only)'
    : route.subagents.join(' -> ');

  return `[ORCHESTRATION_ROUTE trusted=true complexity=${route.complexity} implementation=${route.requiresImplementation}]
Required route: ${subagents}.
User request (preserve intent exactly):
${request}`;
}
