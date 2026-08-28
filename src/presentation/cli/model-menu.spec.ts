const mockSelectOutcome = jest.fn();
const mockAskText = jest.fn();

jest.mock('./interactive-select', () => ({
  isInteractive: () => true,
  selectOutcome: mockSelectOutcome,
}));

jest.mock('./prompts', () => ({
  askNumber: jest.fn(),
  askText: mockAskText,
}));

import { ModelSwitcher } from '../../core/config/model-switcher';
import { showModelMenu } from './model-menu';

describe('showModelMenu Claude on Vertex', () => {
  const originalProject = process.env.GOOGLE_CLOUD_PROJECT;

  beforeEach(() => {
    mockSelectOutcome.mockReset();
    mockAskText.mockReset();
    delete process.env.GOOGLE_CLOUD_PROJECT;
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalProject === undefined) delete process.env.GOOGLE_CLOUD_PROJECT;
    else process.env.GOOGLE_CLOUD_PROJECT = originalProject;
  });

  it('asks for and persists the missing Vertex project with Haiku 4.5', async () => {
    mockSelectOutcome
      .mockResolvedValueOnce({ status: 'selected', value: 'vertex-anthropic' })
      .mockResolvedValueOnce({
        status: 'selected',
        value: 'vertex-anthropic:claude-haiku-4-5@20251001',
      });
    mockAskText.mockResolvedValue('blue-label-prod');
    jest.spyOn(ModelSwitcher, 'saveClaudeVertexSelectionToEnv').mockReturnValue(true);

    await expect(showModelMenu('gemini-3.5-flash')).resolves.toEqual({
      model: 'vertex-anthropic:claude-haiku-4-5@20251001',
      saved: true,
    });

    const providerChoices = mockSelectOutcome.mock.calls[0][0].choices as Array<{
      value: string;
    }>;
    expect(providerChoices.map((choice) => choice.value)).toEqual([
      'vertex-gemini',
      'vertex-anthropic',
      'ollama',
    ]);
    expect(mockAskText).toHaveBeenCalledTimes(1);
    expect(ModelSwitcher.saveClaudeVertexSelectionToEnv).toHaveBeenCalledWith(
      'vertex-anthropic:claude-haiku-4-5@20251001',
      'blue-label-prod',
      undefined,
    );
    expect(process.env.GOOGLE_CLOUD_PROJECT).toBe('blue-label-prod');
  });

  it('cancels without saving when the entered project id is invalid', async () => {
    mockSelectOutcome
      .mockResolvedValueOnce({ status: 'selected', value: 'vertex-anthropic' })
      .mockResolvedValueOnce({
        status: 'selected',
        value: 'vertex-anthropic:claude-haiku-4-5@20251001',
      });
    mockAskText.mockResolvedValue('MIBLU display name');
    jest.spyOn(ModelSwitcher, 'saveClaudeVertexSelectionToEnv').mockReturnValue(true);

    await expect(showModelMenu('gemini-3.5-flash')).resolves.toBeNull();

    expect(ModelSwitcher.saveClaudeVertexSelectionToEnv).not.toHaveBeenCalled();
  });
});
