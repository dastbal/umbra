import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IndexFileLease } from '../rag/index-file-lease';
import { executeIndexStatus, formatIndexStatusForModel } from './read-only-executions';

describe('get_index_status writer visibility', () => {
  it('reports the live writer and the last warm-up retry', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-status-'));
    const lease = IndexFileLease.acquire(root);
    try {
      lease?.heartbeat('backfill');
      const result = executeIndexStatus(root, {
        phase: 'ready', message: 'Serving durable coverage.',
        lastError: 'SQLITE_BUSY', retryAt: Date.now() + 500,
      });
      expect(result.data.indexer).toMatchObject({ active: true, pid: process.pid, phase: 'backfill', startedAt: expect.any(Number) });
      expect(formatIndexStatusForModel(result)).toContain(`writer pid:    ${process.pid}`);
      expect(formatIndexStatusForModel(result)).toContain('last error:    SQLITE_BUSY');
    } finally {
      lease?.release();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
