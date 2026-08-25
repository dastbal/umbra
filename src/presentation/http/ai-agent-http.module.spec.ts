import type { ServerResponse } from 'http';
import { AiAgentHttpService } from './ai-agent-http.module';
import type { AgentRunStore } from './agent-http.contracts';

class ResponseDouble {
  public statusCode = 0;
  public readonly headers = new Map<string, string>();
  public readonly writes: string[] = [];
  public ended = false;

  public setHeader(name: string, value: string): void { this.headers.set(name, value); }
  public flushHeaders(): void { return; }
  public write(value: string): void { this.writes.push(value); }
  public end(value?: string): void { if (value) this.writes.push(value); this.ended = true; }
}

describe('AiAgentHttpService', () => {
  const runStore: jest.Mocked<AgentRunStore> = {
    create: jest.fn(),
    findForOwner: jest.fn(),
    recordApproval: jest.fn(),
  };

  beforeEach(() => jest.clearAllMocks());

  it('streams only sanitized token and tool metadata after host authorization', async () => {
    runStore.create.mockResolvedValue({ id: 'run-1', ownerId: 'user-1', createdAt: '2026-08-25T00:00:00.000Z' });
    const agent = {
      async *streamEvents() {
        yield { event: 'on_tool_start', name: 'safe_write_file', data: { input: { content: 'secret' } } };
        yield { event: 'on_chat_model_stream', data: { chunk: { content: 'Done' } } };
        yield { event: 'on_tool_end', name: 'safe_write_file' };
      },
    };
    const service = new AiAgentHttpService({ authorizer: { authorize: jest.fn().mockResolvedValue({ id: 'user-1' }) }, runStore }, agent);
    const response = new ResponseDouble();

    await service.stream({}, { instruction: 'Write a safe file' }, response as unknown as ServerResponse);

    const body = response.writes.join('');
    expect(response.statusCode).toBe(200);
    expect(body).toContain('run.started');
    expect(body).toContain('tool.started');
    expect(body).toContain('agent.token');
    expect(body).not.toContain('secret');
    expect(response.ended).toBe(true);
  });

  it('rejects an approval from a principal who does not own the run', async () => {
    runStore.findForOwner.mockResolvedValue(undefined);
    const service = new AiAgentHttpService(
      { authorizer: { authorize: jest.fn().mockResolvedValue({ id: 'other-user' }) }, runStore },
      { async *streamEvents() { return; } },
    );

    await expect(service.approve({}, 'run-1', 'approval-1', true)).resolves.toEqual({ accepted: false });
    expect(runStore.recordApproval).not.toHaveBeenCalled();
  });
});
