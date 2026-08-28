/** Authenticated principal supplied by the consuming NestJS application. */
export interface AgentHttpPrincipal {
  id: string;
}

/** Host-owned authentication and authorization boundary for agent HTTP requests. */
export interface AgentHttpAuthorizer {
  authorize(request: unknown): Promise<AgentHttpPrincipal>;
}

/** Persisted metadata for an HTTP agent run. */
export interface AgentRunRecord {
  id: string;
  ownerId: string;
  createdAt: string;
}

/** Durable store required for HTTP runs and approval decisions. */
export interface AgentRunStore {
  create(ownerId: string): Promise<AgentRunRecord>;
  findForOwner(runId: string, ownerId: string): Promise<AgentRunRecord | undefined>;
  recordApproval(runId: string, approvalId: string, approved: boolean): Promise<void>;
}

/** Input accepted by the HTTP stream endpoint. */
export interface AgentStreamRequest {
  instruction: string;
}

/** Safe SSE event emitted by the optional NestJS transport. */
export interface AgentStreamEvent {
  type: 'run.started' | 'agent.token' | 'tool.started' | 'tool.completed' | 'run.completed' | 'run.blocked' | 'run.failed';
  runId: string;
  data?: Record<string, string | number | boolean>;
}
