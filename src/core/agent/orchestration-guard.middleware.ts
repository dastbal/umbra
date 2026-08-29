import { ToolMessage } from '@langchain/core/messages';
import { isGraphInterrupt } from '@langchain/langgraph';
import { createMiddleware } from 'langchain';
import {
  assertDelegationAllowed,
  evaluateDelegation,
  type DelegationHistory,
  type GuardedSubagent,
  type VerificationStatus,
} from './orchestration-policy';
import {
  assertMandateComplete,
  IncompleteMandateError,
  type Mandate,
} from './delegation/mandate';
import {
  currentTurn,
  nextDelegationId,
  openTurn,
  recordFinding,
  type DelegationLedger,
} from './delegation/delegation-registry';
import { classifyDelegationOutcome } from './delegation/delegation-outcome';
import { readPromotion } from './lane-registry';
import { readLane } from './route-lane';

const ROUTE_MARKER = '[ORCHESTRATION_ROUTE';

/**
 * The tool a delegation travels through.
 *
 * Named once, because the guard reads it in two places — authorizing a call and
 * counting past ones — and two spellings of the same name is how a guard starts
 * agreeing with itself about the wrong thing.
 */
export const DELEGATION_TOOL = 'delegate';

/**
 * Questions a delegate may put to the operator before it must answer with what
 * it has.
 *
 * Two, deliberately. `docs/deferred-work.md` recorded the hazard before the
 * channel existed: the risk is not the price of a question but a model that
 * asks about everything, spending a turn each time. That limit has never been
 * exercised in production and must be treated as unproven until a trace shows
 * how a delegate actually uses it.
 */
export const DEFAULT_QUESTION_ALLOWANCE = 2;

/** Limits the orchestration guard enforces for one interactive turn. */
export interface GuardLimits {
  /** Maximum correction cycles permitted after verification. */
  maxRetries: number;
  /** Tool attempts available to the whole turn, shared by every delegate. */
  maxAgentTurns: number;
}

/**
 * Creates a LangGraph middleware that enforces delegated workflow transitions.
 *
 * The guard now does four things at the moment of delegation, in this order:
 *
 * 1. **Checks the transition** against the Researcher → Coder → Verifier
 *    lifecycle, as it always did.
 * 2. **Checks the order.** A delegate sees only the `description` string, so a
 *    delegation that does not carry the user's request, the objective and what
 *    is already known is refused — and refused *repairably*, as a tool result
 *    holding the template, not as an exception that ends the turn.
 * 3. **Grants a budget** from the turn's single pool, and records the mandate
 *    where the delegate's own middleware and `ask_delegator` can find it.
 * 4. **Hands the delegate prose instead of JSON.** The orchestrator writes the
 *    order as JSON because that is what a model emits reliably inside a string
 *    field; the delegate receives headed prose because that is what a model
 *    reads. The guard is the translator between the two.
 *
 * @param limits - Retry and budget limits for the turn.
 * @returns Middleware suitable for `createDeepAgent`.
 */
export function createOrchestrationGuard(limits: GuardLimits) {
  return createMiddleware({
    name: 'OrchestrationGuard',
    wrapToolCall: async (request, handler) => {
      if (request.toolCall.name !== DELEGATION_TOOL) return handler(request);

      // The provider validated the shape before this ran: `subagent` is a
      // required enum on the tool's own schema. A call that reaches here without
      // one could only come from a caller bypassing the declaration.
      const subagent = getGuardedSubagent(request.toolCall.args);
      if (!subagent) {
        throw new Error(describeSubagentRejection(request.toolCall.args));
      }

      // The assistant message holding this call is already in `state.messages`
      // when the guard runs, so the in-flight id must be excluded — otherwise the
      // guard counts the delegation it is authorizing as a previous one.
      const decision = evaluateDelegation(
        readDelegationHistory(
          request.state.messages,
          request.toolCall.id,
          readThreadId(request),
        ),
        subagent,
        limits.maxRetries,
      );
      assertDelegationAllowed(decision);

      const ledger = openTurnForRequest(request, limits.maxAgentTurns);
      if (!ledger) return handler(request);

      const order = request.toolCall.args;
      try {
        assertMandateComplete(order);
      } catch (error: unknown) {
        if (!(error instanceof IncompleteMandateError)) throw error;
        return refuseRepairably(request.toolCall.id, error);
      }

      const delegationId = nextDelegationId(ledger, subagent);
      const granted = ledger.pool.allocate(delegationId, subagent);
      if (granted === 0) {
        return refuseForBudget(request.toolCall.id, subagent);
      }

      const mandate: Mandate = {
        ...order,
        budget: { toolCalls: granted, questions: DEFAULT_QUESTION_ALLOWANCE },
      };
      ledger.mandates.set(delegationId, mandate);
      ledger.activeDelegationId = delegationId;

      try {
        const result = await handler(request);
        harvestFindings(ledger, result);
        closeDelegation(ledger, delegationId);
        return result;
      } catch (error: unknown) {
        // A suspension is not the end of a delegation, it is a pause. Releasing
        // the grant and clearing the pointer here would leave the resumed tool
        // body with no delegation to belong to — the re-execution hazard
        // ADR-011 documents, reached through a `finally` instead of a `catch`.
        if (!isGraphInterrupt(error)) closeDelegation(ledger, delegationId);
        throw error;
      }
    },
  });
}

/**
 * Extracts the current-turn workflow state from LangGraph's persisted messages.
 *
 * @param messages - The thread's persisted messages.
 * @param inFlightToolCallId - Identifier of the `task` call being authorized right
 * now, excluded from the counts.
 *
 * That exclusion is the whole point of the parameter. LangGraph appends the
 * assistant message that holds a tool call **before** the tool runs, so a guard
 * reading this history mid-authorization sees its own pending request. With
 * `evaluateDelegation` allowing a researcher only while `researcherCalls === 0`,
 * the count of one meant every first delegation was refused as *"Researcher
 * already ran for this request"* — with no researcher having run. The
 * orchestrator could not delegate at all.
 *
 * ## What counts as an attempt — reversed on purpose, 2026-08-27
 *
 * This function used to count every delegation *request*, whether or not it
 * produced anything, and a test asserted that semantic so a crashed subagent
 * could not be retried forever. That protection had a cost nobody had measured:
 * a Researcher killed by the recursion limit had already spent the turn's only
 * researcher slot, so the orchestrator asking again was told *"Researcher
 * already ran for this request"* — with no research in hand and no way forward.
 * That dead end was observed live.
 *
 * Now only a delegation that **decided** something spends an attempt: one that
 * returned an artifact, or returned a partial handoff. A delegation that
 * produced no result at all did not decide anything and does not count. The
 * runaway-retry concern the old rule protected against is now held by the
 * budget pool instead: every retry is granted from the same turn budget, so a
 * failure that repeats runs out of money without needing a counter of its own.
 *
 * @returns The delegation state for the current turn.
 */
export function readDelegationHistory(
  messages: readonly unknown[],
  inFlightToolCallId?: string,
  threadId?: string,
): DelegationHistory {
  const currentTurnMessages = messages.slice(findCurrentTurnStart(messages));
  const text = currentTurnMessages.map(toText).join('\n');
  const artifacts = readDelegationArtifacts(currentTurnMessages, inFlightToolCallId);

  return {
    // The lane the envelope declared, unless the turn has since been raised —
    // triage sorts an unrecognised request down, and escalate_route is how one
    // that turned out to need a change says so.
    routeRequiresImplementation:
      (readPromotion(threadId, readTurnKey(messages))?.lane ?? readLane(text)) === 'change',
    researcherCalls: artifacts.researcherCalls,
    coderCalls: artifacts.coderCalls,
    verifierResults: artifacts.verifierResults,
    researcherReady: artifacts.researcherStatus === 'ready',
    researcherBlocked: artifacts.researcherStatus === 'blocked',
  };
}

/**
 * Explains why a `task` call was rejected, distinguishing the two causes.
 *
 * Both used to produce the same sentence — *"unregistered subagent, only
 * researcher, coder and verifier are allowed"* — including the case where the
 * argument was simply absent. That message sent a real investigation to the
 * wrong place: the model had asked for `researcher`, but under the key `agent`
 * instead of `subagent_type`, because the `task` declaration never reached the
 * provider and its argument names had to be guessed (ADR-013).
 *
 * This changes only the diagnosis. What the guard permits is unchanged.
 *
 * @param args - The arguments the model supplied to `task`.
 * @returns A message naming the actual defect.
 */
export function describeSubagentRejection(args: unknown): string {
  const allowed = 'researcher, coder, and verifier';

  if (!isRecord(args)) {
    return `Orchestration guard rejected a task call with no arguments object. `
      + `Call task with subagent_type set to one of ${allowed}.`;
  }

  const requested = args.subagent_type;
  if (typeof requested !== 'string' || requested.trim() === '') {
    const keys = Object.keys(args);
    const received = keys.length > 0 ? `keys received: ${keys.join(', ')}` : 'no arguments were supplied';
    return `Orchestration guard rejected a task call with no 'subagent_type' argument (${received}). `
      + `Set subagent_type to one of ${allowed}.`;
  }

  return `Orchestration guard rejected an unregistered subagent '${requested.trim()}'. `
    + `Only ${allowed} are allowed.`;
}

/**
 * Identifies the turn a delegation belongs to, from persisted messages.
 *
 * Two independent quantities are combined because neither is sufficient alone:
 * the position of the route marker is stable within a turn but is zero when no
 * marker exists, and the count of user instructions grows once per turn but
 * says nothing about routing. Together they change between turns and hold still
 * inside one, which is all a budget scope needs.
 *
 * @param messages - The thread's persisted messages.
 * @returns A key identifying the current turn.
 */
export function readTurnKey(messages: readonly unknown[]): string {
  const humanMessages = messages.filter(isHumanMessage).length;
  return `${findCurrentTurnStart(messages)}:${humanMessages}`;
}

/** Reads the thread a request belongs to, when it has one. */
function readThreadId(request: unknown): string | undefined {
  const configurable = (request as { runtime?: { configurable?: Record<string, unknown> } })
    .runtime?.configurable;
  const threadId = configurable?.['thread_id'];
  return typeof threadId === 'string' ? threadId : undefined;
}

function openTurnForRequest(request: unknown, totalBudget: number): DelegationLedger | undefined {
  const typed = request as { runtime?: { configurable?: Record<string, unknown> }; state?: { messages?: unknown[] } };
  const threadId = typed.runtime?.configurable?.['thread_id'];
  if (typeof threadId !== 'string') return currentTurn(undefined);

  return openTurn(threadId, readTurnKey(typed.state?.messages ?? []), totalBudget);
}

/**
 * Ends a delegation: returns what it did not spend and clears the pointer.
 *
 * Never called for a suspended delegation. See the call site.
 */
function closeDelegation(ledger: DelegationLedger, delegationId: string): void {
  ledger.pool.release(delegationId);
  ledger.activeDelegationId = undefined;
}

/**
 * Hands back an order the provider accepted but that carries too little to act on.
 *
 * The schema enforces that the fields are **present**; it cannot judge whether
 * `objective` says anything. Judging content is what remains here, and it is
 * returned as a tool result rather than thrown: a message the model can rewrite
 * must never end the turn.
 */
function refuseRepairably(toolCallId: string | undefined, error: IncompleteMandateError): ToolMessage {
  return new ToolMessage({
    tool_call_id: toolCallId ?? '',
    content: `${error.message}

Fill those arguments on the delegate call and issue it again.`,
  });
}

function refuseForBudget(toolCallId: string | undefined, subagent: GuardedSubagent): ToolMessage {
  return new ToolMessage({
    tool_call_id: toolCallId ?? '',
    content:
      `This turn has no budget left to delegate to the ${subagent}; only the reserve remains. `
      + `Do not delegate again. Answer now with what has been established, and state plainly what `
      + `was not investigated.`,
  });
}

/**
 * Copies a returned artifact's findings into the turn's shared memory.
 *
 * Tolerant by design: an artifact that cannot be read yields nothing and the
 * delegation is unaffected. Failing a completed delegation over unreadable
 * bookkeeping would discard work that already succeeded.
 */
function harvestFindings(ledger: DelegationLedger, result: unknown): void {
  const text = toText(result);
  const start = text.indexOf('{');
  if (start === -1) return;

  try {
    const parsed = JSON.parse(text.slice(start)) as { findings?: unknown };
    if (!Array.isArray(parsed.findings)) return;
    for (const finding of parsed.findings) {
      if (typeof finding === 'string') recordFinding(ledger, finding);
    }
  } catch {
    return;
  }
}

function getGuardedSubagent(args: unknown): GuardedSubagent | undefined {
  if (!isRecord(args) || typeof args.subagent !== 'string') return undefined;
  const normalized = args.subagent.trim().toLowerCase();
  return normalized === 'researcher' || normalized === 'coder' || normalized === 'verifier'
    ? normalized
    : undefined;
}

function findCurrentTurnStart(messages: readonly unknown[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (toText(messages[index]).includes(ROUTE_MARKER)) return index;
  }
  return 0;
}

function isHumanMessage(message: unknown): boolean {
  if (!isRecord(message)) return false;
  if (message.type === 'human') return true;
  return typeof message.getType === 'function' && message.getType() === 'human';
}

interface DelegationArtifacts {
  researcherCalls: number;
  coderCalls: number;
  researcherStatus?: 'ready' | 'blocked';
  verifierResults: VerificationStatus[];
}

function readDelegationArtifacts(
  messages: readonly unknown[],
  inFlightToolCallId?: string,
): DelegationArtifacts {
  const artifacts: DelegationArtifacts = {
    researcherCalls: 0,
    coderCalls: 0,
    verifierResults: [],
  };
  const taskById = new Map<string, GuardedSubagent>();
  const resultStatusById = readResultStatuses(messages);

  for (const message of messages) {
    for (const taskCall of readTaskCalls(message, inFlightToolCallId)) {
      if (taskCall.id) taskById.set(taskCall.id, taskCall.subagent);
      if (!spendsAnAttempt(taskCall.id, resultStatusById)) continue;
      if (taskCall.subagent === 'researcher') artifacts.researcherCalls += 1;
      if (taskCall.subagent === 'coder') artifacts.coderCalls += 1;
    }

    const result = readTaskResult(message);
    if (!result) continue;
    const subagent = taskById.get(result.toolCallId);
    if (subagent === 'researcher' && (result.status === 'ready' || result.status === 'blocked')) {
      artifacts.researcherStatus = result.status;
    }
    if (subagent === 'verifier' && isVerificationStatus(result.status)) {
      artifacts.verifierResults.push(result.status);
    }
  }
  return artifacts;
}

/**
 * Decides whether a recorded delegation spent one of its role's attempts.
 *
 * A call with no result at all is a delegation that died without deciding
 * anything — the recursion limit, a rejected provider request, a transport
 * failure. It does not count. See {@link readDelegationHistory} for why this
 * reverses the earlier rule.
 */
function spendsAnAttempt(
  toolCallId: string | undefined,
  resultStatusById: Map<string, string | undefined>,
): boolean {
  if (toolCallId === undefined) return true;
  if (!resultStatusById.has(toolCallId)) return false;

  return classifyDelegationOutcome({ artifactStatus: resultStatusById.get(toolCallId) }).consumesAttempt;
}

function readResultStatuses(messages: readonly unknown[]): Map<string, string | undefined> {
  const statuses = new Map<string, string | undefined>();
  for (const message of messages) {
    if (!isRecord(message) || typeof message.tool_call_id !== 'string') continue;
    statuses.set(message.tool_call_id, readArtifactStatus(toText(message)));
  }
  return statuses;
}

interface TaskCall {
  id?: string;
  subagent: GuardedSubagent;
}

function readTaskCalls(message: unknown, inFlightToolCallId?: string): TaskCall[] {
  if (!isRecord(message) || !Array.isArray(message.tool_calls)) return [];

  return message.tool_calls.flatMap((toolCall) => {
    if (!isRecord(toolCall) || toolCall.name !== DELEGATION_TOOL) return [];
    // The call being authorized is not part of its own history.
    if (inFlightToolCallId !== undefined && toolCall.id === inFlightToolCallId) return [];
    const subagent = getGuardedSubagent(toolCall.args);
    if (subagent === undefined) return [];
    return [{ id: typeof toolCall.id === 'string' ? toolCall.id : undefined, subagent }];
  });
}

interface TaskResult {
  toolCallId: string;
  status: string;
}

function readTaskResult(message: unknown): TaskResult | undefined {
  if (!isRecord(message) || typeof message.tool_call_id !== 'string') return undefined;
  const status = readArtifactStatus(toText(message));
  return status === undefined ? undefined : { toolCallId: message.tool_call_id, status };
}

function readArtifactStatus(content: string): string | undefined {
  const match = /"status"\s*:\s*"([a-z]+)"/.exec(content);
  return match?.[1];
}

function isVerificationStatus(status: string): status is VerificationStatus {
  return status === 'passed' || status === 'failed' || status === 'blocked';
}

function toText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(toText).join('\n');
  if (isRecord(value) && 'content' in value) return toText(value.content);
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
