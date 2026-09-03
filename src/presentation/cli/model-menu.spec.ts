const mockSelectOutcome = jest.fn();
const mockAskText = jest.fn();
const mockConfirm = jest.fn();
const mockSetConfiguredEmbeddingsProvider = jest.fn();
const mockPinEmbeddingsProvider = jest.fn();
const mockIndexProject = jest.fn();

jest.mock('./interactive-select', () => ({
  isInteractive: () => true,
  selectOutcome: mockSelectOutcome,
}));

jest.mock('./prompts', () => ({
  askNumber: jest.fn(),
  askText: mockAskText,
  confirm: mockConfirm,
}));

jest.mock('../../core/rag/indexer', () => ({
  IndexerService: jest.fn().mockImplementation(() => ({ indexProject: mockIndexProject })),
}));

jest.mock('../../core/config/agent-config-writer', () => ({
  setConfiguredEmbeddingsProvider: mockSetConfiguredEmbeddingsProvider,
}));

jest.mock('../../core/rag/embeddings/embeddings-resolver', () => ({
  resolveEmbeddings: () => ({
    port: { identity: { provider: 'ollama', model: 'nomic-embed-text' } },
  }),
  pinEmbeddingsProvider: mockPinEmbeddingsProvider,
}));

jest.mock('../../core/rag/embeddings/embeddings-availability', () => ({
  probeEmbeddings: jest.fn().mockResolvedValue({ available: true }),
}));

import { ModelSwitcher } from '../../core/config/model-switcher';
import { showModelMenu } from './model-menu';

/** One row as presented to `selectOutcome`. */
interface PresentedRow {
  value?: unknown;
  label: string;
  separator?: boolean;
  disabled?: boolean;
  active?: boolean;
  hint?: string;
}

/** Reads the rows presented on one `selectOutcome` call. */
function choicesAt(call: number): PresentedRow[] {
  return mockSelectOutcome.mock.calls[call][0].choices as PresentedRow[];
}

/** Extracts the reasoning levels offered on one screen, in order. */
function levelsAt(call: number): string[] {
  return choicesAt(call)
    .filter((row) => (row.value as { kind?: string } | undefined)?.kind === 'level')
    .map((row) => (row.value as { level: string }).level);
}

/** Restores one environment variable to its pre-test value. */
function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe('showModelMenu Claude on Vertex', () => {
  const originalProject = process.env.GOOGLE_CLOUD_PROJECT;
  const originalReasoning = process.env.AGENT_REASONING;
  const originalDisplay = process.env.AGENT_REASONING_DISPLAY;

  beforeEach(() => {
    mockSelectOutcome.mockReset();
    mockAskText.mockReset();
    mockConfirm.mockReset();
    mockConfirm.mockResolvedValue(false);
    mockIndexProject.mockReset();
    mockSetConfiguredEmbeddingsProvider.mockReset();
    mockSetConfiguredEmbeddingsProvider.mockReturnValue({ path: '.umbra/agent.config.json', saved: true });
    mockPinEmbeddingsProvider.mockReset();
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.AGENT_REASONING;
    delete process.env.AGENT_REASONING_DISPLAY;
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    restore('GOOGLE_CLOUD_PROJECT', originalProject);
    restore('AGENT_REASONING', originalReasoning);
    restore('AGENT_REASONING_DISPLAY', originalDisplay);
  });

  it('asks for and persists the missing Vertex project with Haiku 4.5', async () => {
    mockSelectOutcome
      .mockResolvedValueOnce({ status: 'selected', value: 'vertex-anthropic' })
      .mockResolvedValueOnce({
        status: 'selected',
        value: 'vertex-anthropic:claude-haiku-4-5@20251001',
      })
      .mockResolvedValueOnce({ status: 'selected', value: { kind: 'level', level: 'medium' } });
    mockAskText.mockResolvedValue('blue-label-prod');
    jest.spyOn(ModelSwitcher, 'saveSelectionToEnv').mockReturnValue(true);

    await expect(showModelMenu('gemini-3.5-flash')).resolves.toEqual({
      model: 'vertex-anthropic:claude-haiku-4-5@20251001',
      saved: true,
    });

    expect(choicesAt(0).map((choice) => choice.value)).toEqual([
      'vertex-gemini',
      'vertex-anthropic',
      'ollama',
      'embeddings',
      undefined, // the "configuration" separator carries no value
      'setup',
    ]);
    expect(mockAskText).toHaveBeenCalledTimes(1);
    expect(ModelSwitcher.saveSelectionToEnv).toHaveBeenCalledWith(
      {
        model: 'vertex-anthropic:claude-haiku-4-5@20251001',
        reasoningLevel: 'medium',
        showReasoning: false,
        projectId: 'blue-label-prod',
      },
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
    jest.spyOn(ModelSwitcher, 'saveSelectionToEnv').mockReturnValue(true);

    await expect(showModelMenu('gemini-3.5-flash')).resolves.toBeNull();

    expect(ModelSwitcher.saveSelectionToEnv).not.toHaveBeenCalled();
  });

  it('offers the five effort levels on Claude Opus 5', async () => {
    process.env.GOOGLE_CLOUD_PROJECT = 'blue-label';
    mockSelectOutcome
      .mockResolvedValueOnce({ status: 'selected', value: 'vertex-anthropic' })
      .mockResolvedValueOnce({ status: 'selected', value: 'vertex-anthropic:claude-opus-5' })
      .mockResolvedValueOnce({ status: 'selected', value: { kind: 'level', level: 'xhigh' } });
    jest.spyOn(ModelSwitcher, 'saveSelectionToEnv').mockReturnValue(true);

    await showModelMenu('gemini-3.5-flash');

    expect(levelsAt(2)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });
});

describe('showModelMenu embeddings provider', () => {
  beforeEach(() => {
    mockSelectOutcome.mockReset();
    mockConfirm.mockReset();
    mockConfirm.mockResolvedValue(false);
    mockIndexProject.mockReset();
    mockSetConfiguredEmbeddingsProvider.mockReset();
    mockSetConfiguredEmbeddingsProvider.mockReturnValue({ path: '.umbra/agent.config.json', saved: true });
    mockPinEmbeddingsProvider.mockReset();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('persists and pins a provider without hot-swapping the chat model', async () => {
    mockSelectOutcome
      .mockResolvedValueOnce({ status: 'selected', value: 'embeddings' })
      .mockResolvedValueOnce({ status: 'selected', value: 'vertex' });

    await expect(showModelMenu('gemini-3.5-flash')).resolves.toBeNull();

    expect(choicesAt(1).map((choice) => choice.value)).toEqual(['ollama', 'vertex']);
    expect(mockSetConfiguredEmbeddingsProvider).toHaveBeenCalledWith(process.cwd(), 'vertex');
    expect(mockPinEmbeddingsProvider).toHaveBeenCalledWith('vertex');
    expect(mockConfirm).toHaveBeenCalledWith(expect.objectContaining({
      question: expect.stringContaining('sends repository code to Vertex AI'),
      defaultValue: false,
    }));
    expect(mockIndexProject).not.toHaveBeenCalled();
  });

  it('builds the selected provider only after explicit confirmation', async () => {
    mockSelectOutcome
      .mockResolvedValueOnce({ status: 'selected', value: 'embeddings' })
      .mockResolvedValueOnce({ status: 'selected', value: 'vertex' });
    mockConfirm.mockResolvedValue(true);
    mockIndexProject.mockResolvedValue(undefined);

    await expect(showModelMenu('gemini-3.5-flash')).resolves.toBeNull();

    expect(mockIndexProject).toHaveBeenCalledTimes(1);
  });
});

describe('showModelMenu reasoning screen', () => {
  const originalReasoning = process.env.AGENT_REASONING;
  const originalDisplay = process.env.AGENT_REASONING_DISPLAY;

  beforeEach(() => {
    mockSelectOutcome.mockReset();
    mockAskText.mockReset();
    delete process.env.AGENT_REASONING;
    delete process.env.AGENT_REASONING_DISPLAY;
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(ModelSwitcher, 'saveSelectionToEnv').mockReturnValue(true);
    jest.spyOn(ModelSwitcher, 'getVertexModels').mockReturnValue([
      { name: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
      { name: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    ]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    restore('AGENT_REASONING', originalReasoning);
    restore('AGENT_REASONING_DISPLAY', originalDisplay);
  });

  it('updates process.env so the rebuilt agent uses the new settings', async () => {
    // The agent is rebuilt in this same process and the provider reads these
    // from process.env. Writing only .env would have applied the *previous*
    // selection's reasoning to the newly chosen model.
    process.env.AGENT_REASONING = 'high';
    process.env.AGENT_REASONING_DISPLAY = 'true';

    mockSelectOutcome
      .mockResolvedValueOnce({ status: 'selected', value: 'vertex-gemini' })
      .mockResolvedValueOnce({ status: 'selected', value: 'gemini-3.5-flash' })
      .mockResolvedValueOnce({ status: 'selected', value: { kind: 'level', level: 'low' } });

    await showModelMenu('gemini-2.5-pro');

    expect(process.env.AGENT_REASONING).toBe('low');
    expect(process.env.AGENT_REASONING_DISPLAY).toBe('false');
  });

  it('clears the level in process.env when the model default is chosen', async () => {
    process.env.AGENT_REASONING = 'max';

    mockSelectOutcome
      .mockResolvedValueOnce({ status: 'selected', value: 'vertex-gemini' })
      .mockResolvedValueOnce({ status: 'selected', value: 'gemini-3.5-flash' })
      .mockResolvedValueOnce({ status: 'selected', value: { kind: 'default' } });

    await showModelMenu('gemini-2.5-pro');

    expect(process.env.AGENT_REASONING).toBe('');
  });

  it('offers the four thinkingLevel steps on Gemini 3.x, never xhigh or max', async () => {
    mockSelectOutcome
      .mockResolvedValueOnce({ status: 'selected', value: 'vertex-gemini' })
      .mockResolvedValueOnce({ status: 'selected', value: 'gemini-3.5-flash' })
      .mockResolvedValueOnce({ status: 'selected', value: { kind: 'level', level: 'minimal' } });

    await showModelMenu('gemini-2.5-pro');

    expect(levelsAt(2)).toEqual(['minimal', 'low', 'medium', 'high']);
  });

  it('offers only budget-expressible levels on Gemini 2.5, which rejects thinkingLevel', async () => {
    mockSelectOutcome
      .mockResolvedValueOnce({ status: 'selected', value: 'vertex-gemini' })
      .mockResolvedValueOnce({ status: 'selected', value: 'gemini-2.5-pro' })
      .mockResolvedValueOnce({ status: 'selected', value: { kind: 'default' } });

    await showModelMenu('gemini-3.5-flash');

    expect(levelsAt(2)).toEqual(['low', 'medium', 'high']);
    expect(ModelSwitcher.saveSelectionToEnv).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gemini-2.5-pro', reasoningLevel: undefined }),
      undefined,
    );
  });

  it('marks the display row unavailable on Gemini 3.x and refuses to flip it', async () => {
    // The library derives `includeThoughts` from the token budget, so a
    // level-based Gemini request can never return thoughts. The row says so
    // instead of offering a switch that would do nothing.
    mockSelectOutcome
      .mockResolvedValueOnce({ status: 'selected', value: 'vertex-gemini' })
      .mockResolvedValueOnce({ status: 'selected', value: 'gemini-3.5-flash' })
      .mockResolvedValueOnce({ status: 'selected', value: { kind: 'level', level: 'high' } });

    await showModelMenu('gemini-3.5-flash');

    const toggle = choicesAt(2).find(
      (row) => (row.value as { kind?: string } | undefined)?.kind === 'toggle-display',
    );
    expect(toggle?.disabled).toBe(true);
    expect(toggle?.hint).toBe('not available for this model');
    expect(ModelSwitcher.saveSelectionToEnv).toHaveBeenCalledWith(
      expect.objectContaining({ showReasoning: false }),
      undefined,
    );
  });

  // Corrected 2026-08-28 with the ADR-006 amendment. This row used to assert a
  // filled box, on the understanding that a forced-on model's reasoning was
  // always displayed. It is no longer printed by anyone, so a filled box would
  // claim something the CLI does not do — the row stays unactionable, and the
  // hint now says the reasoning is billed rather than shown.
  it('marks the display row unactionable for the budget-based models', async () => {
    mockSelectOutcome
      .mockResolvedValueOnce({ status: 'selected', value: 'vertex-gemini' })
      .mockResolvedValueOnce({ status: 'selected', value: 'gemini-2.5-pro' })
      .mockResolvedValueOnce({ status: 'selected', value: { kind: 'level', level: 'low' } });

    await showModelMenu('gemini-3.5-flash');

    const toggle = choicesAt(2).find(
      (row) => (row.value as { kind?: string } | undefined)?.kind === 'toggle-display',
    );
    expect(toggle?.disabled).toBe(true);
    expect(toggle?.label).toContain('☐');
    expect(toggle?.hint).toContain('not printed');
  });

  it('skips the reasoning screen for Ollama, which has no reasoning controls', async () => {
    jest.spyOn(ModelSwitcher, 'detectOllamaModels').mockReturnValue([
      { name: 'gemma4', size: '4.7 GB' },
    ]);
    mockSelectOutcome
      .mockResolvedValueOnce({ status: 'selected', value: 'ollama' })
      .mockResolvedValueOnce({ status: 'selected', value: 'gemma4' });

    await expect(showModelMenu('gemini-3.5-flash')).resolves.toEqual({
      model: 'ollama:gemma4',
      saved: true,
    });

    expect(mockSelectOutcome).toHaveBeenCalledTimes(2);
    expect(ModelSwitcher.saveSelectionToEnv).toHaveBeenCalledWith(
      {
        model: 'ollama:gemma4',
        reasoningLevel: undefined,
        showReasoning: false,
        projectId: undefined,
      },
      undefined,
    );
  });

  it('opens on the clamped level when the saved one does not exist on the new model', async () => {
    process.env.AGENT_REASONING = 'max';
    mockSelectOutcome
      .mockResolvedValueOnce({ status: 'selected', value: 'vertex-gemini' })
      .mockResolvedValueOnce({ status: 'selected', value: 'gemini-3.5-flash' })
      .mockResolvedValueOnce({ status: 'selected', value: { kind: 'level', level: 'high' } });

    await showModelMenu('vertex-anthropic:claude-opus-5');

    // `max` is real on Claude Opus 5 and absent on Gemini 3.5. The highlight
    // lands on `high` rather than on nothing, so the operator sees what the
    // model will actually run at.
    const active = choicesAt(2)
      .filter((row) => row.active)
      .map((row) => row.label.trim());
    expect(active).toEqual(['high']);
  });

});

describe('showModelMenu reasoning display on Claude 5', () => {
  const originalProject = process.env.GOOGLE_CLOUD_PROJECT;
  const originalReasoning = process.env.AGENT_REASONING;
  const originalDisplay = process.env.AGENT_REASONING_DISPLAY;

  beforeEach(() => {
    mockSelectOutcome.mockReset();
    mockAskText.mockReset();
    process.env.GOOGLE_CLOUD_PROJECT = 'blue-label';
    delete process.env.AGENT_REASONING;
    delete process.env.AGENT_REASONING_DISPLAY;
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(ModelSwitcher, 'saveSelectionToEnv').mockReturnValue(true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    restore('GOOGLE_CLOUD_PROJECT', originalProject);
    restore('AGENT_REASONING', originalReasoning);
    restore('AGENT_REASONING_DISPLAY', originalDisplay);
  });

  it('re-renders after the toggle and persists the flipped state', async () => {
    // Claude 5 is the only family whose display Umbra actually controls.
    mockSelectOutcome
      .mockResolvedValueOnce({ status: 'selected', value: 'vertex-anthropic' })
      .mockResolvedValueOnce({ status: 'selected', value: 'vertex-anthropic:claude-opus-5' })
      .mockResolvedValueOnce({ status: 'selected', value: { kind: 'toggle-display' } })
      .mockResolvedValueOnce({ status: 'selected', value: { kind: 'level', level: 'max' } });

    await showModelMenu('gemini-3.5-flash');

    // Four screens: provider, model, reasoning, then reasoning again after the
    // toggle — the operator sees the new state before committing to a level.
    expect(mockSelectOutcome).toHaveBeenCalledTimes(4);

    const toggleBefore = choicesAt(2).find(
      (row) => (row.value as { kind?: string } | undefined)?.kind === 'toggle-display',
    );
    const toggleAfter = choicesAt(3).find(
      (row) => (row.value as { kind?: string } | undefined)?.kind === 'toggle-display',
    );
    expect(toggleBefore?.disabled).toBeFalsy();
    expect(toggleBefore?.label).toContain('☐');
    expect(toggleAfter?.label).toContain('☑');

    expect(ModelSwitcher.saveSelectionToEnv).toHaveBeenCalledWith(
      expect.objectContaining({ reasoningLevel: 'max', showReasoning: true }),
      undefined,
    );
  });
});
