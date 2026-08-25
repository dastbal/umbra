import { Body, Controller, DynamicModule, Inject, Injectable, Module, Param, Post, Req, Res } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { ServerResponse } from 'http';
import { AI_AGENT } from '../../core/agent/tokens';
import type {
  AgentHttpAuthorizer,
  AgentRunStore,
  AgentStreamEvent,
  AgentStreamRequest,
} from './agent-http.contracts';

const AGENT_HTTP_OPTIONS = 'AI_AGENT_HTTP_OPTIONS';

/** Configuration required to expose the optional HTTP transport safely. */
export interface AiAgentHttpModuleOptions {
  authorizer: AgentHttpAuthorizer;
  runStore: AgentRunStore;
}

interface AgentRuntimeEvent {
  event: string;
  name?: string;
  data?: { chunk?: { content?: unknown } };
}

interface AgentRuntime {
  streamEvents(input: unknown, config: unknown): AsyncIterable<AgentRuntimeEvent>;
}

/** Writes authenticated agent runs as a privacy-safe SSE stream. */
@Injectable()
export class AiAgentHttpService {
  /** @param options Host-owned authorization and durable persistence adapters. */
  public constructor(
    @Inject(AGENT_HTTP_OPTIONS) private readonly options: AiAgentHttpModuleOptions,
    @Inject(AI_AGENT) private readonly agent: AgentRuntime,
  ) {}

  /** Starts one authorized agent stream and emits only sanitized runtime metadata. */
  public async stream(request: unknown, input: AgentStreamRequest, response: ServerResponse): Promise<void> {
    if (typeof input.instruction !== 'string' || input.instruction.trim().length === 0 || input.instruction.length > 10_000) {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: 'A non-empty instruction of at most 10000 characters is required.' }));
      return;
    }

    const principal = await this.options.authorizer.authorize(request);
    const run = await this.options.runStore.create(principal.id);
    this.beginSse(response);
    this.writeEvent(response, { type: 'run.started', runId: run.id });

    try {
      for await (const event of this.agent.streamEvents(
        { messages: [{ role: 'human', content: input.instruction }] },
        { configurable: { thread_id: `http-${run.id}` }, recursionLimit: 50 },
      )) {
        const safeEvent = this.toSafeEvent(event, run.id);
        if (safeEvent) this.writeEvent(response, safeEvent);
      }
      this.writeEvent(response, { type: 'run.completed', runId: run.id });
    } catch {
      this.writeEvent(response, { type: 'run.failed', runId: run.id, data: { category: 'runtime_error' } });
    } finally {
      response.end();
    }
  }

  /** Stores an authenticated human approval for a paused run. */
  public async approve(request: unknown, runId: string, approvalId: string, approved: boolean): Promise<{ accepted: boolean }> {
    const principal = await this.options.authorizer.authorize(request);
    const run = await this.options.runStore.findForOwner(runId, principal.id);
    if (!run) return { accepted: false };
    await this.options.runStore.recordApproval(runId, approvalId, approved);
    return { accepted: true };
  }

  /** Converts framework events into payloads that never include tool arguments or model data. */
  private toSafeEvent(event: AgentRuntimeEvent, runId: string): AgentStreamEvent | undefined {
    if (event.event === 'on_tool_start') return { type: 'tool.started', runId, data: { name: event.name ?? 'unknown' } };
    if (event.event === 'on_tool_end') return { type: 'tool.completed', runId, data: { name: event.name ?? 'unknown' } };
    if (event.event !== 'on_chat_model_stream') return undefined;
    const content = event.data?.chunk?.content;
    const token = typeof content === 'string' ? content : undefined;
    return token ? { type: 'agent.token', runId, data: { token } } : undefined;
  }

  /** Initializes a standard text/event-stream response. */
  private beginSse(response: ServerResponse): void {
    response.statusCode = 200;
    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.flushHeaders();
  }

  /** Serializes one safe SSE event. */
  private writeEvent(response: ServerResponse, event: AgentStreamEvent): void {
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }
}

/** Optional NestJS HTTP/SSE presentation module. */
@Controller('agent')
export class AiAgentHttpController {
  /** @param service Authorized HTTP agent service. */
  public constructor(private readonly service: AiAgentHttpService) {}

  /** Streams an authorized execution through `POST /agent/stream`. */
  @Post('stream')
  public async stream(@Req() request: unknown, @Body() input: AgentStreamRequest, @Res() response: ServerResponse): Promise<void> {
    await this.service.stream(request, input, response);
  }

  /** Records a durable approval decision for `POST /agent/runs/:runId/approvals/:approvalId`. */
  @Post('runs/:runId/approvals/:approvalId')
  public async approve(
    @Req() request: unknown,
    @Param('runId') runId: string,
    @Param('approvalId') approvalId: string,
    @Body() body: { approved?: boolean },
  ): Promise<{ accepted: boolean }> {
    return this.service.approve(request, runId, approvalId, body.approved === true);
  }
}

/** Registers authenticated, durable HTTP/SSE transport for an existing `AiAgentModule`. */
@Module({})
export class AiAgentHttpModule {
  /** Registers the optional controller and its host-owned adapters. */
  public static forRoot(options: AiAgentHttpModuleOptions): DynamicModule {
    return {
      module: AiAgentHttpModule,
      controllers: [AiAgentHttpController],
      providers: [AiAgentHttpService, { provide: AGENT_HTTP_OPTIONS, useValue: options }],
    };
  }
}

/** Generates a durable-store-safe run identifier for adapters that need one. */
export function createAgentRunId(): string {
  return randomUUID();
}
