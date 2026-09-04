import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

/** A JSON object whose values may be arbitrary MCP client configuration. */
type JsonObject = Record<string, unknown>;

/** Reports how {@link ensureUmbraMcpConfiguration} affected the client configuration. */
export interface McpConfigurationResult {
  /** Absolute path of the MCP client configuration. */
  path: string;
  /** Whether the Umbra server was added, updated, or already current. */
  status: 'created' | 'updated' | 'unchanged';
}

/** A locally detectable MCP client with a verified Umbra configuration adapter. */
export type SupportedMcpClient = 'codex' | 'claude';

/** Describes a detected client without changing any consumer configuration. */
export interface DetectedMcpClient {
  /** Client identifier accepted by the setup command. */
  readonly client: SupportedMcpClient;
  /** Executable that was found on PATH. */
  readonly executable: string;
}

/** Returns the stdio process shape usable by any MCP client. */
export function buildUmbraMcpServer(rootDir: string): JsonObject {
  return {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@dastbal/umbra', 'mcp', '--root', path.resolve(rootDir)],
  };
}

/** Detects only clients whose configuration contract Umbra verifies and owns. */
export function detectSupportedMcpClients(): DetectedMcpClient[] {
  const candidates: readonly DetectedMcpClient[] = [
    { client: 'codex', executable: 'codex' },
    { client: 'claude', executable: 'claude' },
  ];
  return candidates.filter(({ executable }) => executableExists(executable));
}

/** Configures Codex through its own CLI and verifies the resulting named entry. */
export function configureCodexMcp(rootDir: string): void {
  const resolvedRoot = path.resolve(rootDir);
  execFileSync(
    'codex',
    ['mcp', 'add', 'umbra', '--', 'npx', '-y', '@dastbal/umbra', 'mcp', '--root', resolvedRoot],
    { stdio: 'pipe', windowsHide: true },
  );
  execFileSync('codex', ['mcp', 'get', 'umbra'], { stdio: 'pipe', windowsHide: true });
}

/**
 * Adds or refreshes Umbra's stdio entry in a project-scoped `.mcp.json` file.
 *
 * Existing MCP servers are preserved verbatim. The repository root is resolved
 * before it is persisted, so a client cannot accidentally serve a different
 * directory because it started from another working directory.
 *
 * @param rootDir - Repository that Umbra will serve and that owns `.mcp.json`.
 * @returns The configuration path and whether Umbra's entry changed.
 * @throws {Error} When an existing file is invalid JSON or not an MCP object.
 */
export function ensureUmbraMcpConfiguration(rootDir: string): McpConfigurationResult {
  const resolvedRoot = path.resolve(rootDir);
  const configPath = path.join(resolvedRoot, '.mcp.json');
  const desiredServer = buildUmbraMcpServer(resolvedRoot);
  const existing = readMcpConfiguration(configPath);
  const mcpServers = existing.mcpServers;
  const currentServer = mcpServers.umbra;

  if (isSameJson(currentServer, desiredServer)) {
    return { path: configPath, status: 'unchanged' };
  }

  mcpServers.umbra = desiredServer;
  const serialized = `${JSON.stringify(existing.document, null, 2)}\n`;
  fs.writeFileSync(configPath, serialized, 'utf8');

  return {
    path: configPath,
    status: currentServer === undefined ? 'created' : 'updated',
  };
}

/** Builds the process definition that pins Umbra to one repository at launch. */
/** Checks command availability without executing its target client workflow. */
function executableExists(executable: string): boolean {
  try {
    execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [executable], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

/** Reads a valid MCP configuration, or prepares a new empty one. */
function readMcpConfiguration(configPath: string): { document: JsonObject; mcpServers: JsonObject } {
  if (!fs.existsSync(configPath)) {
    const mcpServers: JsonObject = {};
    return { document: { mcpServers }, mcpServers };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as unknown;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot update ${configPath}: invalid JSON (${message}).`);
  }

  if (!isJsonObject(parsed)) {
    throw new Error(`Cannot update ${configPath}: its root must be a JSON object.`);
  }

  const mcpServers = parsed.mcpServers;
  if (mcpServers === undefined) {
    const createdServers: JsonObject = {};
    parsed.mcpServers = createdServers;
    return { document: parsed, mcpServers: createdServers };
  }

  if (!isJsonObject(mcpServers)) {
    throw new Error(`Cannot update ${configPath}: "mcpServers" must be a JSON object.`);
  }

  return { document: parsed, mcpServers };
}

/** Checks whether a value is a plain JSON object rather than an array or null. */
function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Compares JSON values without relying on their property insertion order. */
function isSameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
