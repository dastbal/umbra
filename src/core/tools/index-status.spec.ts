import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IndexFileLease } from '../rag/index-file-lease';
import * as indexIntegrity from '../rag/index-integrity';
import { executeIndexStatus, formatIndexStatusForModel } from './read-only-executions';

describe('get_index_status writer visibility', () => {
  it('names pending and stale paths when vectors are ready but coverage is degraded', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-degraded-'));
    const inspected = jest.spyOn(indexIntegrity, 'inspectIndexIntegrity').mockReturnValue({
      healthy: false, pendingPaths: ['src/new.ts', 'src/other.ts'], stalePaths: ['src/old.ts'],
      missingVectors: 0, missingPaths: [], chunklessPaths: [], dimensionConflictIdentities: [],
      databaseExists: true, schemaValid: true, discoveryValid: true, discoveredFiles: 3,
      files: 3, indexedFiles: 1, skippedFiles: 0, skipped: [], chunks: 1,
    } as unknown as indexIntegrity.IndexIntegrityReport);
    try {
      const result = executeIndexStatus(root, { phase: 'ready', message: 'Durable vector coverage is ready.' });
      expect(result.code).toBe('INDEX_STATUS_DEGRADED');
      expect(result.summary).toContain('2 pending');
      expect(result.summary).toContain('1 stale');
      expect(result.data.lifecycle.message).toContain('pending');
      expect(result.nextAction).toContain('umbra index');
    } finally {
      inspected.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

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
