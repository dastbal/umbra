import * as crypto from 'crypto';
import * as fs from 'fs';
import { AgentDB } from './db';

/**
 * Represents the database row structure for a file.
 */
export interface FileRecord {
  path: string;
  hash: string;
  last_indexed: number;
  skeleton_signature: string | null;
}

/**
 * Manages the state of the codebase files.
 * Responsible for detecting changes (hashing) and caching skeletons.
 */
export class FileRegistry {
  private db = AgentDB.getInstance();

  /**
   * Checks if a file has changed since the last index.
   * * @param filePath - Relative path of the file (e.g., 'src/users.service.ts')
   * @returns {boolean} True if the file is new or modified; False if cached.
   */
  public isFileChanged(filePath: string, absolutePath: string = filePath): boolean {
    // 1. If file was deleted or doesn't exist, strictly it "changed" (it's gone),
    // but for indexing purposes, we skip it or handle cleanup.
    if (!fs.existsSync(absolutePath)) return true;

    // 2. Compute current Hash
    const content = fs.readFileSync(absolutePath, 'utf-8');
    const newHash = this.computeHash(content);

    // 3. Query DB
    const stmt = this.db.prepare(
      'SELECT hash FROM file_registry WHERE path = ?',
    );
    const row = stmt.get(filePath) as { hash: string } | undefined;

    // 4. Decision Logic
    if (!row) {
      return true; // New file
    }
    if (row.hash !== newHash) {
      return true; // Modified file
    }

    return false; // Pristine (Cached)
  }

  /**
   * Updates the registry with the new file state.
   * This should be called AFTER the vector indexing and skeleton generation is done.
   * * @param filePath - The path of the file
   * @param skeleton - The JSON string representing the AST Skeleton (Class/Method signatures)
   */
  public updateFile(filePath: string, skeleton: object | null, absolutePath: string = filePath) {
    if (!fs.existsSync(absolutePath)) return;

    const content = fs.readFileSync(absolutePath, 'utf-8');
    const hash = this.computeHash(content);
    const now = Date.now();
    const skeletonStr = skeleton ? JSON.stringify(skeleton) : null;

    // UPSERT: Insert or Update if exists
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO file_registry (path, hash, last_indexed, skeleton_signature)
      VALUES (?, ?, ?, ?)
    `);

    stmt.run(filePath, hash, now, skeletonStr);
  }

  /**
   * Retrieves the cached skeleton for a file.
   * Used by the LLM Provider to build context without reading the full disk.
   */
  public getSkeleton(filePath: string): object | null {
    const stmt = this.db.prepare(
      'SELECT skeleton_signature FROM file_registry WHERE path = ?',
    );

    const row: FileRecord = stmt.get(filePath) as FileRecord;

    if (row && row.skeleton_signature) {
      return JSON.parse(row.skeleton_signature);
    }
    return null;
  }

  /**
   * Helper: Generates MD5 hash of string content.
   */
  private computeHash(content: string): string {
    return crypto.createHash('md5').update(content).digest('hex');
  }
}
