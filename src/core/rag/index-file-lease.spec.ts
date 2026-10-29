import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IndexFileLease, inspectIndexFileLease } from './index-file-lease';

describe('IndexFileLease', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-index-file-lease-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('allows one writer before SQLite is opened and exposes its pid and phase', () => {
    const first = IndexFileLease.acquire(root);
    expect(first).toBeDefined();
    try {
      expect(IndexFileLease.acquire(root)).toBeUndefined();
      first?.heartbeat('backfill');
      expect(inspectIndexFileLease(root)).toMatchObject({
        active: true, pid: process.pid, phase: 'backfill', startedAt: expect.any(Number),
      });
    } finally {
      first?.release();
    }
    expect(IndexFileLease.acquire(root)).toBeDefined();
  });

  it('recovers an orphaned lease directory whose owner died before writing metadata', () => {
    const directory = path.join(root, '.umbra', 'indexer.lease');
    fs.mkdirSync(directory, { recursive: true });
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(directory, old, old);
    const lease = IndexFileLease.acquire(root);
    try {
      expect(lease).toBeDefined();
      expect(inspectIndexFileLease(root)).toMatchObject({ active: true, pid: process.pid });
    } finally {
      lease?.release();
    }
  });

  it('recovers an abandoned recovery marker and a stale heartbeat even when the PID exists', () => {
    const directory = path.join(root, '.umbra', 'indexer.lease');
    const recovery = `${directory}.recovery`;
    fs.mkdirSync(directory, { recursive: true });
    fs.mkdirSync(recovery);
    const oldTime = Date.now() - 10 * 60_000;
    fs.writeFileSync(path.join(directory, 'owner.json'), JSON.stringify({
      ownerId: 'orphan', pid: process.pid, startedAt: oldTime, heartbeatAt: oldTime, phase: 'indexing',
    }));
    const old = new Date(oldTime);
    fs.utimesSync(recovery, old, old);

    const lease = IndexFileLease.acquire(root);
    try {
      expect(lease).toBeDefined();
      expect(inspectIndexFileLease(root)).toMatchObject({ active: true, stale: false, pid: process.pid });
    } finally {
      lease?.release();
    }
  });
});
