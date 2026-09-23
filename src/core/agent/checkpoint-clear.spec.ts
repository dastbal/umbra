// Importing the factory for real pulls `deepagents` in, and with it an ESM-only
// `p-retry` that Jest cannot load. Only the checkpoint helper is under test, and
// it touches neither of these.
jest.mock('deepagents', () => ({
  createDeepAgent: jest.fn(),
  registerHarnessProfile: jest.fn(),
}));

import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { emptyCheckpoint } from '@langchain/langgraph-checkpoint';
import { DeepAgentFactory } from './deep-agent-factory';
import { agentPath } from '../config/agent-directory';

/**
 * Covers the reset that ADR-005 and ADR-007 decided and the code did not
 * perform.
 *
 * The previous implementation deleted from `checkpoint_writes`, `checkpoints`
 * and `checkpoint_blobs`. Only `checkpoints` exists; the other two threw into an
 * empty `catch`, so the `writes` rows survived every "clear" — and those rows
 * are the half that holds an interrupted tool call, which is the exact state the
 * reset exists to remove.
 */
describe('clearCorruptedCheckpoint', () => {
  let rootDir: string;
  let dbPath: string;

  /** Counts the rows one thread still owns in each real table. */
  function rowsFor(threadId: string): { checkpoints: number; writes: number } {
    const db = new Database(dbPath, { readonly: true });
    try {
      const count = (table: string) =>
        (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE thread_id = ?`).get(threadId) as { n: number }).n;
      return { checkpoints: count('checkpoints'), writes: count('writes') };
    } finally {
      db.close();
    }
  }

  /** Writes one checkpoint and one pending write, the way a live turn does. */
  async function seed(threadId: string): Promise<void> {
    const saver = SqliteSaver.fromConnString(dbPath);
    try {
      const config = { configurable: { thread_id: threadId, checkpoint_ns: '' } };
      const stored = await saver.put(config, emptyCheckpoint(), { source: 'input', step: -1, parents: {} });
      await saver.putWrites(stored, [['messages', { role: 'tool', content: '' }]], 'task-1');
    } finally {
      saver.db.close();
    }
  }

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'checkpoint-clear-'));
    mkdirSync(agentPath(rootDir), { recursive: true });
    dbPath = agentPath(rootDir, 'deep_agent_history.db');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('removes the pending writes as well as the checkpoints', async () => {
    await seed('deep-broken');
    expect(rowsFor('deep-broken')).toEqual({ checkpoints: 1, writes: 1 });

    const cleared = await DeepAgentFactory.clearCorruptedCheckpoint(rootDir, 'deep-broken');

    expect(cleared).toBe(true);
    expect(rowsFor('deep-broken')).toEqual({ checkpoints: 0, writes: 0 });
  });

  it('leaves every other session alone', async () => {
    await seed('deep-broken');
    await seed('deep-healthy');

    await DeepAgentFactory.clearCorruptedCheckpoint(rootDir, 'deep-broken');

    expect(rowsFor('deep-healthy')).toEqual({ checkpoints: 1, writes: 1 });
  });

  it('reports nothing cleared when the thread was never checkpointed', async () => {
    await seed('deep-healthy');

    expect(await DeepAgentFactory.clearCorruptedCheckpoint(rootDir, 'deep-absent')).toBe(false);
  });

  it('reports nothing cleared when the database does not exist at all', async () => {
    expect(await DeepAgentFactory.clearCorruptedCheckpoint(rootDir, 'deep-broken')).toBe(false);
  });
});
