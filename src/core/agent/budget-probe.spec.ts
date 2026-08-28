import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  BUDGET_PROBE_ENV,
  BUDGET_PROBE_FILE,
  countMessagesWithToolCallsArray,
  describeMessageType,
  isBudgetProbeEnabled,
  recordBudgetProbe,
} from './budget-probe';
import { agentPath } from '../config/agent-directory';

describe('budget probe', () => {
  let rootDir: string;
  const originalFlag = process.env[BUDGET_PROBE_ENV];

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'budget-probe-'));
    delete process.env[BUDGET_PROBE_ENV];
  });

  afterEach(() => {
    if (originalFlag === undefined) delete process.env[BUDGET_PROBE_ENV];
    else process.env[BUDGET_PROBE_ENV] = originalFlag;
    rmSync(rootDir, { recursive: true, force: true });
  });

  const probeFile = (): string => join(agentPath(rootDir, 'telemetry'), BUDGET_PROBE_FILE);

  it('is disabled unless the flag is set, so a normal run writes nothing', () => {
    expect(isBudgetProbeEnabled()).toBe(false);
    recordBudgetProbe(rootDir, { at: 'wrapModelCall', messageCount: 3 });
    expect(existsSync(probeFile())).toBe(false);
  });

  it('appends one JSON line per observation when enabled', () => {
    process.env[BUDGET_PROBE_ENV] = '1';
    recordBudgetProbe(rootDir, { at: 'wrapModelCall', countedToolCalls: 0 });
    recordBudgetProbe(rootDir, { at: 'on_chat_model_end', hasUsageMetadata: true });

    const lines = readFileSync(probeFile(), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual(expect.objectContaining({
      at: 'wrapModelCall',
      countedToolCalls: 0,
    }));
    expect(JSON.parse(lines[1]).hasUsageMetadata).toBe(true);
    expect(typeof JSON.parse(lines[0]).ts).toBe('string');
  });

  it('never throws when the destination cannot be written', () => {
    process.env[BUDGET_PROBE_ENV] = '1';
    expect(() => recordBudgetProbe('\0invalid', { at: 'wrapToolCall' })).not.toThrow();
  });

  it('reads a message discriminator from either the plain or the class form', () => {
    expect(describeMessageType({ type: 'human' })).toBe('human');
    expect(describeMessageType({ getType: () => 'ai' })).toBe('ai');
    expect(describeMessageType({})).toBe('unknown');
    expect(describeMessageType(null)).toBe('unknown');
    expect(describeMessageType({ getType: () => { throw new Error('nope'); } })).toBe('unknown');
  });

  it('counts only messages carrying the tool_calls array the budget reads', () => {
    expect(countMessagesWithToolCallsArray([
      { type: 'human' },
      { type: 'ai', tool_calls: [{ name: 'list_files' }] },
      { type: 'ai', tool_calls: [] },
      // A provider that reports calls anywhere else is invisible to the counter,
      // which is the hypothesis this probe exists to settle.
      { type: 'ai', additional_kwargs: { function_call: {} } },
      null,
    ])).toBe(2);
  });
});
