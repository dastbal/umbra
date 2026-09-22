import { interrupt, isGraphInterrupt } from '@langchain/langgraph';
import { requestApproval } from './approval';

jest.mock('@langchain/langgraph', () => ({
  interrupt: jest.fn(),
  isGraphInterrupt: jest.fn(),
}));

jest.mock('./logger', () => ({
  log: { ai: jest.fn(), tool: jest.fn(), sys: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockInterrupt = interrupt as jest.MockedFunction<typeof interrupt>;
const mockIsGraphInterrupt = isGraphInterrupt as unknown as jest.Mock;

/**
 * Answers as the CLI does: echoing the `actionId` of the action being decided.
 *
 * @param decision - The decision the operator made.
 */
function answerWith(decision: { type: string; message?: string }): void {
  mockInterrupt.mockImplementation((request: unknown) => ({
    decisions: [{ ...decision, actionId: (request as any).actionRequests[0].actionId }],
  }));
}

describe('requestApproval', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsGraphInterrupt.mockReturnValue(false);
  });

  it('returns true only when the operator approves', () => {
    answerWith({ type: 'approve' });
    expect(requestApproval('delete_file', { file_path: 'src/a.ts' }, 'Deleting requires approval.')).toBe(true);
  });

  it('returns false when the operator rejects', () => {
    answerWith({ type: 'reject', message: 'not this one' });
    expect(requestApproval('delete_file', { file_path: 'src/a.ts' }, 'Deleting requires approval.')).toBe(false);
  });

  it('emits the HITL payload shape the CLI already renders', () => {
    answerWith({ type: 'approve' });
    requestApproval('safe_write_file', { file_path: 'package.json' }, 'Configuration change.');
    expect(mockInterrupt).toHaveBeenCalledWith({
      actionRequests: [
        {
          name: 'safe_write_file',
          args: { file_path: 'package.json' },
          description: 'Configuration change.',
          actionId: expect.any(String),
        },
      ],
      reviewConfigs: [{ actionName: 'safe_write_file', allowedDecisions: ['approve', 'reject'] }],
    });
  });

  it('re-throws a GraphInterrupt instead of treating it as a failure', () => {
    const suspension = new Error('__interrupt__');
    mockInterrupt.mockImplementation(() => {
      throw suspension;
    });
    mockIsGraphInterrupt.mockReturnValue(true);
    expect(() => requestApproval('delete_file', { file_path: 'src/a.ts' }, 'why')).toThrow(suspension);
  });

  it('refuses when there is no approval channel at all', () => {
    mockInterrupt.mockImplementation(() => {
      throw new Error('interrupt() called outside the context of a graph');
    });
    expect(requestApproval('delete_file', { file_path: 'src/a.ts' }, 'why')).toBe(false);
  });

  it('refuses an absent or malformed decision', () => {
    mockInterrupt.mockReturnValue(undefined);
    expect(requestApproval('delete_file', { file_path: 'src/a.ts' }, 'why')).toBe(false);
    mockInterrupt.mockReturnValue({ decisions: [] });
    expect(requestApproval('delete_file', { file_path: 'src/a.ts' }, 'why')).toBe(false);
  });

  // Inside one task LangGraph hands resume values out by position, so an answer
  // given to an earlier question can arrive here. An approval that does not name
  // this action authorizes nothing.
  it('refuses an approval that answers a different action', () => {
    mockInterrupt.mockReturnValue({ decisions: [{ type: 'approve', actionId: 'a-different-action' }] });
    expect(requestApproval('delete_file', { file_path: 'src/a.ts' }, 'why')).toBe(false);
  });

  it('refuses an approval with no action named at all', () => {
    mockInterrupt.mockReturnValue({ decisions: [{ type: 'approve' }] });
    expect(requestApproval('delete_file', { file_path: 'src/a.ts' }, 'why')).toBe(false);
  });

  it('approves the matching action when several were answered at once', () => {
    mockInterrupt.mockImplementation((request: unknown) => ({
      decisions: [
        { type: 'reject', actionId: 'some-other-action' },
        { type: 'approve', actionId: (request as any).actionRequests[0].actionId },
      ],
    }));
    expect(requestApproval('delete_file', { file_path: 'src/a.ts' }, 'why')).toBe(true);
  });

  // `interrupt()` re-runs the whole tool body on resume, so the fingerprint has
  // to be a pure function of the request. A generated id would differ on the
  // second pass and refuse every approval the operator gave.
  it('fingerprints the same action identically on every pass', () => {
    const seen: string[] = [];
    mockInterrupt.mockImplementation((request: unknown) => {
      const actionId = (request as any).actionRequests[0].actionId as string;
      seen.push(actionId);
      return { decisions: [{ type: 'approve', actionId }] };
    });

    requestApproval('delete_file', { file_path: 'src/a.ts' }, 'why');
    requestApproval('delete_file', { file_path: 'src/a.ts' }, 'a different reason');

    expect(seen[0]).toBe(seen[1]);
  });

  it('fingerprints a different action differently', () => {
    const seen: string[] = [];
    mockInterrupt.mockImplementation((request: unknown) => {
      const actionId = (request as any).actionRequests[0].actionId as string;
      seen.push(actionId);
      return { decisions: [{ type: 'approve', actionId }] };
    });

    requestApproval('delete_file', { file_path: 'src/a.ts' }, 'why');
    requestApproval('delete_file', { file_path: 'src/b.ts' }, 'why');
    requestApproval('safe_write_file', { file_path: 'src/a.ts' }, 'why');

    expect(new Set(seen).size).toBe(3);
  });
});
