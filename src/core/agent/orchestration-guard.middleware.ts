import { createMiddleware } from 'langchain';
import {
  assertDelegationAllowed,
  evaluateDelegation,
  type DelegationHistory,
  type GuardedSubagent,
  type VerificationStatus,
} from './orchestration-policy';

const ROUTE_MARKER = '[ORCHESTRATION_ROUTE';

/** Creates a LangGraph middleware that enforces delegated workflow transitions. */
export function createOrchestrationGuard(maxRetries: number) {
  return createMiddleware({
    name: 'OrchestrationGuard',
    wrapToolCall: async (request, handler) => {
      if (request.toolCall.name !== 'task') return handler(request);

      const subagent = getGuardedSubagent(request.toolCall.args);
      if (!subagent) {
        throw new Error(
          'Orchestration guard rejected an unregistered subagent. Only researcher, coder, and verifier are allowed.',
        );
      }

      const decision = evaluateDelegation(
        readDelegationHistory(request.state.messages),
        subagent,
        maxRetries,
      );
      assertDelegationAllowed(decision);
      return handler(request);
    },
  });
}

/** Extracts the current-turn workflow state from LangGraph's persisted messages. */
export function readDelegationHistory(messages: readonly unknown[]): DelegationHistory {
  const currentTurn = messages.slice(findCurrentTurnStart(messages));
  const text = currentTurn.map(toText).join('\n');
  const artifacts = readDelegationArtifacts(currentTurn);

  return {
    routeRequiresImplementation: !text.includes('implementation=false]'),
    researcherCalls: artifacts.researcherCalls,
    coderCalls: artifacts.coderCalls,
    verifierResults: artifacts.verifierResults,
    researcherReady: artifacts.researcherStatus === 'ready',
    researcherBlocked: artifacts.researcherStatus === 'blocked',
  };
}

function getGuardedSubagent(args: unknown): GuardedSubagent | undefined {
  if (!isRecord(args) || typeof args.subagent_type !== 'string') return undefined;
  const normalized = args.subagent_type.trim().toLowerCase();
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

interface DelegationArtifacts {
  researcherCalls: number;
  coderCalls: number;
  researcherStatus?: 'ready' | 'blocked';
  verifierResults: VerificationStatus[];
}

function readDelegationArtifacts(messages: readonly unknown[]): DelegationArtifacts {
  const artifacts: DelegationArtifacts = {
    researcherCalls: 0,
    coderCalls: 0,
    verifierResults: [],
  };
  const taskById = new Map<string, GuardedSubagent>();

  for (const message of messages) {
    for (const taskCall of readTaskCalls(message)) {
      if (taskCall.subagent === 'researcher') artifacts.researcherCalls += 1;
      if (taskCall.subagent === 'coder') artifacts.coderCalls += 1;
      if (taskCall.id) taskById.set(taskCall.id, taskCall.subagent);
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

interface TaskCall {
  id?: string;
  subagent: GuardedSubagent;
}

function readTaskCalls(message: unknown): TaskCall[] {
  if (!isRecord(message) || !Array.isArray(message.tool_calls)) return [];

  return message.tool_calls.flatMap((toolCall) => {
    if (!isRecord(toolCall) || toolCall.name !== 'task') return [];
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
