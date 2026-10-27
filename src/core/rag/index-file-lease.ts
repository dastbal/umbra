import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { agentPath } from '../config/agent-directory';

/** Cross-process index writer observed without opening SQLite. */
export interface IndexFileLeaseSnapshot {
  readonly active: boolean;
  readonly stale?: boolean;
  readonly pid?: number;
  readonly startedAt?: number;
  readonly heartbeatAt?: number;
  readonly phase?: string;
}

interface LeaseOwner {
  readonly ownerId: string;
  readonly pid: number;
  readonly startedAt: number;
  readonly heartbeatAt: number;
  readonly phase: string;
}

/** Atomic directory ownership acquired before the writer opens SQLite. */
export class IndexFileLease {
  private constructor(private readonly directory: string, private owner: LeaseOwner) {}

  /** Acquires the one writer slot; a live owner makes this process a reader. */
  public static acquire(rootDir: string): IndexFileLease | undefined {
    const stateDir = agentPath(rootDir);
    fs.mkdirSync(stateDir, { recursive: true });
    const directory = path.join(stateDir, 'indexer.lease');
    const acquire = (): IndexFileLease | undefined => {
      try {
        fs.mkdirSync(directory);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
        throw error;
      }
      const now = Date.now();
      const owner: LeaseOwner = { ownerId: crypto.randomUUID(), pid: process.pid, startedAt: now, heartbeatAt: now, phase: 'opening' };
      fs.writeFileSync(path.join(directory, 'owner.json'), JSON.stringify(owner));
      return new IndexFileLease(directory, owner);
    };
    const first = acquire();
    if (first !== undefined) return first;
    const current = inspectIndexFileLease(rootDir);
    if (!current.stale) return undefined;
    // Serialize stale-owner recovery. Without this second atomic directory,
    // two reclaimers could move each other's newly acquired lease aside.
    const recovery = `${directory}.recovery`;
    try {
      fs.mkdirSync(recovery);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
      throw error;
    }
    try {
      if (!inspectIndexFileLease(rootDir).stale) return undefined;
      const archived = `${directory}.stale-${crypto.randomUUID()}`;
      fs.renameSync(directory, archived);
      fs.rmSync(archived, { recursive: true, force: true });
      return acquire();
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return acquire();
    } finally {
      fs.rmSync(recovery, { recursive: true, force: true });
    }
  }

  /** Updates the owner's visible phase and heartbeat without changing ownership. */
  public heartbeat(phase: string = this.owner.phase): void {
    if (readOwner(this.directory)?.ownerId !== this.owner.ownerId) return;
    this.owner = { ...this.owner, heartbeatAt: Date.now(), phase };
    const temporary = path.join(this.directory, `owner-${this.owner.ownerId}.tmp`);
    fs.writeFileSync(temporary, JSON.stringify(this.owner));
    fs.renameSync(temporary, path.join(this.directory, 'owner.json'));
  }

  /** Releases only the directory this instance still owns. */
  public release(): void {
    if (readOwner(this.directory)?.ownerId === this.owner.ownerId) {
      fs.rmSync(this.directory, { recursive: true, force: true });
    }
  }
}

/** Reads current writer identity and phase without opening the shared index. */
export function inspectIndexFileLease(rootDir: string): IndexFileLeaseSnapshot {
  const directory = path.join(agentPath(rootDir), 'indexer.lease');
  if (!fs.existsSync(directory)) return { active: false };
  const owner = readOwner(directory);
  if (owner === undefined) {
    const age = Date.now() - fs.statSync(directory).mtimeMs;
    return { active: true, stale: age > 30_000 };
  }
  let stale = false;
  try {
    process.kill(owner.pid, 0);
  } catch (error: unknown) {
    stale = (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
  return {
    active: true, stale, pid: owner.pid, startedAt: owner.startedAt,
    heartbeatAt: owner.heartbeatAt, phase: owner.phase,
  };
}

/** Parses a complete owner record; an in-progress mkdir remains occupied. */
function readOwner(directory: string): LeaseOwner | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(directory, 'owner.json'), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const value = parsed as Partial<LeaseOwner>;
    return typeof value.ownerId === 'string' && typeof value.pid === 'number'
      && typeof value.startedAt === 'number' && typeof value.heartbeatAt === 'number'
      && typeof value.phase === 'string'
      ? value as LeaseOwner : undefined;
  } catch { return undefined; }
}
