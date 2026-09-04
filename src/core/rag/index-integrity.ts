import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

import { agentPath } from '../config/agent-directory';
import type { EmbeddingsIdentity } from './embeddings/embeddings.port';

/** Vector population grouped by its immutable provider/model identity. */
export interface VectorIdentityCoverage {
  readonly provider: string;
  readonly model: string;
  readonly dimensions: number;
  readonly vectors: number;
}

/** Read-only evidence about the semantic index stored for one workspace root. */
export interface IndexIntegrityReport {
  readonly databasePath: string;
  readonly databaseExists: boolean;
  readonly schemaValid: boolean;
  readonly files: number;
  readonly chunks: number;
  readonly vectors: readonly VectorIdentityCoverage[];
  readonly missingVectors: number;
  readonly missingPaths: readonly string[];
  readonly selectedIdentity?: Pick<EmbeddingsIdentity, 'provider' | 'model'>;
  readonly healthy: boolean;
  readonly diagnostic?: string;
}

/**
 * Inspects the durable index without starting a provider or writing a database.
 *
 * @param rootDir - Root owning the `.umbra` workspace.
 * @param selectedIdentity - Optional provider/model whose coverage must be complete.
 * @returns Counts and concrete missing paths suitable for CLI and MCP diagnostics.
 */
export function inspectIndexIntegrity(
  rootDir: string,
  selectedIdentity?: Pick<EmbeddingsIdentity, 'provider' | 'model'>,
): IndexIntegrityReport {
  const databasePath = agentPath(path.resolve(rootDir), 'memory.db');
  if (!fs.existsSync(databasePath)) {
    return emptyReport(databasePath, selectedIdentity, 'No .umbra/memory.db exists for this root.');
  }

  let db: Database.Database | undefined;
  try {
    db = new Database(databasePath, { readonly: true, fileMustExist: true });
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
        .map((row) => row.name),
    );
    if (!tables.has('file_registry') || !tables.has('code_chunks') || !tables.has('chunk_vectors')) {
      return { ...emptyReport(databasePath, selectedIdentity, 'The index schema is missing required tables.'), databaseExists: true };
    }

    const files = count(db, 'SELECT COUNT(*) AS total FROM file_registry');
    const chunks = count(db, 'SELECT COUNT(*) AS total FROM code_chunks');
    const vectors = db.prepare(
      `SELECT provider, model, dimensions, COUNT(*) AS vectors
         FROM chunk_vectors GROUP BY provider, model, dimensions ORDER BY provider, model, dimensions`,
    ).all() as VectorIdentityCoverage[];
    const missingWhere = selectedIdentity === undefined
      ? 'NOT EXISTS (SELECT 1 FROM chunk_vectors v WHERE v.chunk_id = c.id)'
      : 'NOT EXISTS (SELECT 1 FROM chunk_vectors v WHERE v.chunk_id = c.id AND v.provider = ? AND v.model = ?)';
    const parameters = selectedIdentity === undefined ? [] : [selectedIdentity.provider, selectedIdentity.model];
    const missingVectors = count(db, `SELECT COUNT(*) AS total FROM code_chunks c WHERE ${missingWhere}`, parameters);
    const missingPaths = (db.prepare(
      `SELECT DISTINCT c.file_path AS path FROM code_chunks c WHERE ${missingWhere} ORDER BY c.file_path LIMIT 20`,
    ).all(...parameters) as { path: string }[]).map((row) => row.path);
    const expectedVectors = selectedIdentity === undefined ? vectors.reduce((total, entry) => total + entry.vectors, 0) : chunks - missingVectors;
    const healthy = files > 0 && chunks > 0 && expectedVectors > 0 && missingVectors === 0;
    return { databasePath, databaseExists: true, schemaValid: true, files, chunks, vectors, missingVectors, missingPaths, selectedIdentity, healthy };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...emptyReport(databasePath, selectedIdentity, `Could not inspect index database: ${message}`), databaseExists: true };
  } finally {
    db?.close();
  }
}

/** Renders the stable operator-facing form shared by doctor and MCP resources. */
export function formatIndexIntegrity(report: IndexIntegrityReport): string {
  const lines = [
    `database:       ${report.databasePath}`,
    `schema:         ${report.schemaValid ? 'valid' : 'invalid'}`,
    `files:          ${report.files}`,
    `chunks:         ${report.chunks}`,
    `missing vectors: ${report.missingVectors}`,
    `health:         ${report.healthy ? 'healthy' : 'incomplete'}`,
  ];
  if (report.selectedIdentity !== undefined) lines.push(`selected:       ${report.selectedIdentity.provider}/${report.selectedIdentity.model}`);
  for (const vector of report.vectors) lines.push(`vectors:        ${vector.provider}/${vector.model} · ${vector.vectors} × ${vector.dimensions}d`);
  if (report.missingPaths.length > 0) lines.push(`missing paths:  ${report.missingPaths.join(', ')}`);
  if (report.diagnostic !== undefined) lines.push(`diagnostic:     ${report.diagnostic}`);
  return lines.join('\n');
}

/** Creates an incomplete report without pretending that an absent database is empty-but-valid. */
function emptyReport(databasePath: string, selectedIdentity: IndexIntegrityReport['selectedIdentity'], diagnostic: string): IndexIntegrityReport {
  return { databasePath, databaseExists: false, schemaValid: false, files: 0, chunks: 0, vectors: [], missingVectors: 0, missingPaths: [], selectedIdentity, healthy: false, diagnostic };
}

/** Counts a query whose only returned field is `total`. */
function count(db: Database.Database, sql: string, parameters: readonly string[] = []): number {
  return (db.prepare(sql).get(...parameters) as { total: number }).total;
}
