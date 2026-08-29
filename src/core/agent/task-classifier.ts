import type { TaskComplexity } from './contracts';
import { triage, type RouteLane } from './route-lane';

/** Subagents that the interactive orchestrator may invoke for one user turn. */
export type OrchestrationSubagent = 'researcher' | 'coder' | 'verifier';

/**
 * Deterministic routing decision made before an interactive request enters the
 * LangGraph agent. It avoids spending implementation-model calls on questions
 * that can be answered directly, while preserving the full quality gate for
 * every request that can change code.
 */
export interface OrchestrationRoute {
  /**
   * The lane this turn starts in, sorted by what being wrong in it costs.
   *
   * `requiresImplementation` is kept alongside it and derived from it, so a
   * checkpoint written by an earlier version still reads correctly.
   */
  lane: RouteLane;
  /** Size of the requested work. */
  complexity: TaskComplexity;
  /** Whether the request can change project files. */
  requiresImplementation: boolean;
  /** Ordered, mandatory specialists for this turn. */
  subagents: OrchestrationSubagent[];
}

const READ_ONLY_PATTERN = /\b(explain|describe|what is|what does|how does|why|analy[sz]e|audit|review|compare|show|list|explica|describe|qué es|qué hace|cómo funciona|por qué|analiza|audita|revisa|compara|muestra|lista)\b/i;
const GREETING_PATTERN = /^[¿¡\s]*((hi|hello|hey)( there)?|hola|buenas( tardes| noches| días)?|qué tal|cómo estás|qué hacés)[!?.\s]*$/i;
const THANKS_PATTERN = /^[¿¡\s]*(thanks( a lot)?|thank you|thx|(muchas |mil )?gracias)[!?.\s]*$/i;
const FAREWELL_PATTERN = /^[¿¡\s]*(bye|goodbye|see you|chau|chao|adi[oó]s|hasta luego|nos vemos)[!?.\s]*$/i;
const IMPLEMENTATION_PATTERN = /\b(add|create|implement|build|fix|change|modify|update|refactor|rename|remove|delete|migrate|write|generate|agrega|agregar|añade|añadir|crea|crear|implementa|implementar|construye|construir|corrige|corregir|arregla|arreglar|cambia|cambiar|modifica|modificar|actualiza|actualizar|refactoriza|refactorizar|renombra|renombrar|elimina|eliminar|borra|borrar|migra|migrar|escribe|escribir|genera|generar|arma|armar|monta|montar|haz|hacer|hacelo|hazlo)\b/i;
/**
 * Affirmations that mean *proceed*, never *nothing to do*.
 *
 * ADR-020 excluded these from small talk by not listing them, which worked
 * while every unmatched message fell through to work. {@link asksForNothing}
 * inverts that fall-through for very short messages, so the exclusion has to
 * become explicit or "dale" would be answered with a canned greeting instead of
 * continuing the work the operator just approved.
 */
const AFFIRMATION_PATTERN = /^[¿¡\s]*(ok(ay)?|dale|listo|s[ií]|yes|yep|sure|perfecto|genial|buenísimo|segu[ií]|continu[áa]|adelante|hazlo|hacelo|go( ahead)?)[!?.\s]*$/i;

/** A path, a filename or a code identifier — evidence the message names work. */
const WORK_REFERENCE_PATTERN = new RegExp('[/\\\\]|\\.(ts|js|json|md|yml|yaml)\\b|_|\\(\\)', 'i');

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
  const lane = triage(request);

  if (lane !== 'change') {
    return { lane, complexity: 'small', requiresImplementation: false, subagents: [] };
  }

  if (LARGE_PATTERN.test(request)) {
    return {
      lane,
      complexity: 'large',
      requiresImplementation: true,
      subagents: ['researcher', 'coder', 'verifier'],
    };
  }

  return {
    lane,
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

  return `[ORCHESTRATION_ROUTE trusted=true complexity=${route.complexity} lane=${route.lane} implementation=${route.requiresImplementation}]
Required route: ${subagents}.
User request (preserve intent exactly):
${request}`;
}

/**
 * Reports a message that wants an answer rather than a change.
 *
 * A question with no implementation verb asked for an explanation, and routing
 * it to the write path was the same fail-open default described below: the
 * orchestrator would delegate to a Coder over a question mark.
 *
 * @param request - Raw interactive user request.
 * @returns Whether the message is phrased as a question.
 */
/**
 * Reports a message too small to be asking for anything.
 *
 * ## Why the default had to change
 *
 * Every message this classifier did not recognize fell through to
 * `requiresImplementation: true` with the full Researcher → Coder → Verifier
 * route. The intent was conservative — an ambiguous request keeps the quality
 * gate — but the fall-through was not conservative at all: it was fail-open.
 *
 * Observed on 2026-08-28. The operator typed **"maestro"**. It matched no
 * implementation verb, no read-only verb and no greeting, so it was routed as a
 * medium implementation task. The orchestrator delegated to the Researcher and
 * then to the Coder, spent 27 calls and 677.8k tokens for $0.0729, and wrote
 * `src/core/agent/orchestrator.e2e-spec.ts` to disk. Nobody had asked for a
 * file. `umbra deep`, given the same word, answered in one line and called
 * nothing.
 *
 * The two errors are not symmetric. Routing a real request to the read-only path
 * costs a worse answer, and the operator asks again. Routing a greeting to the
 * implementation path costs money and changes the repository. So an
 * unrecognized message that is barely a message stops being treated as work.
 *
 * ## Deliberately narrow
 *
 * At most three words, no implementation or read-only verb, no question mark,
 * and no path, filename or identifier that would suggest it names work. "el
 * login está roto" is four words and stays a task; "maestro" is one and does
 * not. Affirmations are excluded first, because ADR-020 established that "dale"
 * means *proceed* — answering it with a canned line would refuse work the
 * operator just approved.
 *
 * @param request - Raw interactive user request.
 * @returns Whether the message asks for nothing at all.
 */
export function isQuestion(request: string): boolean {
  return request.includes(String.fromCharCode(63)) || request.includes(String.fromCharCode(191));
}

/**
 * Reports a message too small to be asking for anything. See the note above.
 */
export function asksForNothing(request: string): boolean {
  const trimmed = request.trim();
  if (trimmed === '') return true;
  if (AFFIRMATION_PATTERN.test(trimmed)) return false;
  if (trimmed.includes('?') || trimmed.includes('¿')) return false;
  if (WORK_REFERENCE_PATTERN.test(trimmed)) return false;
  if (IMPLEMENTATION_PATTERN.test(trimmed) || READ_ONLY_PATTERN.test(trimmed)) return false;

  return trimmed.split(/\s+/).length <= 3;
}

/** Conversational message kinds that are not a request to do work. */
export type SmallTalkKind = 'greeting' | 'thanks' | 'farewell';

/**
 * Recognises a message that is conversation rather than a task.
 *
 * This exists because the Deep-agent system prompt applies its investigation
 * protocol to every message, with no exception for a message that asks for
 * nothing. One recorded turn spent 11 tool calls and 108 seconds on the word
 * "hey" (`.umbra/telemetry/interactive-turns.jsonl`, audit `84ad7c97`).
 *
 * Deliberately excluded: affirmations such as "ok", "dale", "listo", "yes" and
 * "seguí". Those routinely mean *proceed with what you proposed*, and
 * answering one with a canned line would refuse work the operator just
 * approved. A false negative here costs tokens; a false positive costs the
 * user's actual request.
 *
 * Each pattern is anchored to the whole message, so "hola, agregá un endpoint"
 * stays a task.
 *
 * @param request - Raw interactive user request, already trimmed.
 * @returns The small-talk kind, or `null` when the message asks for work.
 */
export function classifySmallTalk(request: string): SmallTalkKind | null {
  if (GREETING_PATTERN.test(request)) return 'greeting';
  if (THANKS_PATTERN.test(request)) return 'thanks';
  if (FAREWELL_PATTERN.test(request)) return 'farewell';
  return null;
}

/**
 * Reports an unmistakable request to change something.
 *
 * Exported so {@link RouteLane} triage can use it as a fast path. Since triage
 * sorts anything unrecognised **down**, a gap in this vocabulary costs one extra
 * tool call rather than a wrong route — which is the whole point of moving the
 * decision out of the word list.
 *
 * @param request - Raw interactive user request.
 * @returns Whether the message plainly asks for a change.
 */
export function isImplementationRequest(request: string): boolean {
  return IMPLEMENTATION_PATTERN.test(request);
}

/**
 * Reports a request phrased as observation rather than change.
 *
 * @param request - Raw interactive user request.
 * @returns Whether the message asks to be told something.
 */
export function isReadOnlyRequest(request: string): boolean {
  return READ_ONLY_PATTERN.test(request);
}