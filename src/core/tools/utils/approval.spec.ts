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

describe('requestApproval', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsGraphInterrupt.mockReturnValue(false);
  });

  it('returns true only when the operator approves', () => {
    mockInterrupt.mockReturnValue({ decisions: [{ type: 'approve' }] });
    expect(requestApproval('delete_file', { file_path: 'src/a.ts' }, 'Deleting requires approval.')).toBe(true);
  });

  it('returns false when the operator rejects', () => {
    mockInterrupt.mockReturnValue({ decisions: [{ type: 'reject', message: 'not this one' }] });
    expect(requestApproval('delete_file', { file_path: 'src/a.ts' }, 'Deleting requires approval.')).toBe(false);
  });

  it('emits the HITL payload shape the CLI already renders', () => {
    mockInterrupt.mockReturnValue({ decisions: [{ type: 'approve' }] });
    requestApproval('safe_write_file', { file_path: 'package.json' }, 'Configuration change.');
    expect(mockInterrupt).toHaveBeenCalledWith({
      actionRequests: [
        { name: 'safe_write_file', args: { file_path: 'package.json' }, description: 'Configuration change.' },
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
});
