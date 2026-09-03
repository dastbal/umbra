import * as fs from 'fs';
import * as path from 'path';
import { agentPath } from './agent-directory';
import { parseAgentConfig } from './agent-config';
import type { EmbeddingsProvider } from '../rag/embeddings/embeddings.port';

/** Outcome of a local agent-config update. */
export interface AgentConfigWriteResult {
  /** Local policy file that was targeted. */
  readonly path: string;
  /** Whether the validated update reached disk. */
  readonly saved: boolean;
  /** Safe operator-facing explanation when no write occurred. */
  readonly reason?: string;
}

/**
 * Persists the embedding provider without materialising unrelated configuration
 * defaults. A read-modify-write of parsed defaults would turn defaults into
 * accidental permanent operator choices.
 *
 * @param rootDir - Project root whose `.umbra` policy is updated.
 * @param provider - Explicit provider to save, or undefined to clear the choice.
 * @returns The local write outcome.
 */
export function setConfiguredEmbeddingsProvider(
  rootDir: string,
  provider: EmbeddingsProvider | undefined,
): AgentConfigWriteResult {
  const configPath = agentPath(rootDir, 'agent.config.json');
  try {
    const raw = readRawObject(configPath);
    const rag = asRecord(raw.rag);
    const next = {
      ...raw,
      rag: {
        ...rag,
        ...(provider === undefined ? {} : { embeddings: provider }),
      },
    };

    if (provider === undefined) delete (next.rag as Record<string, unknown>).embeddings;
    parseAgentConfig(next);

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const temporary = `${configPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, configPath);
    return { path: configPath, saved: true };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { path: configPath, saved: false, reason: message };
  }
}

/** Reads an optional raw JSON object without introducing configuration defaults. */
function readRawObject(configPath: string): Record<string, unknown> {
  if (!fs.existsSync(configPath)) return {};
  const parsed: unknown = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Agent configuration must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

/** Narrows JSON values to records, rejecting arrays and null. */
function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
