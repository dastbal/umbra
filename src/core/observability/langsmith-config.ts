import * as fs from 'fs';
import { agentPath } from '../config/agent-directory';

/** Credentials and destination selected during optional LangSmith setup. */
export interface LangSmithSetupInput {
  /** Personal or service LangSmith API key. */
  apiKey: string;
  /** LangSmith project that receives Umbra traces. */
  project: string;
  /** Optional self-hosted LangSmith endpoint. */
  endpoint?: string;
}

/** Result of saving an opt-in LangSmith configuration. */
export interface LangSmithSetupResult {
  /** Local, gitignored file holding the LangSmith environment variables. */
  path: string;
}

/** Returns the gitignored, project-local LangSmith environment file. */
export function getLangSmithConfigPath(rootDir: string): string {
  return agentPath(rootDir, 'langsmith.env');
}

/** Reports whether this project already has a local LangSmith configuration. */
export function hasLangSmithConfiguration(rootDir: string): boolean {
  return fs.existsSync(getLangSmithConfigPath(rootDir));
}

/** Quotes a dotenv value so API keys and endpoints keep their exact meaning. */
function quoteEnv(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, '')}"`;
}

/**
 * Stores LangSmith credentials outside the consumer's tracked configuration.
 *
 * The file sits below `.umbra/`, which initialization already ignores. It is
 * intentionally created once: replacing a secret should be a conscious action,
 * not an accidental side effect of running `umbra init` again.
 */
export function configureLangSmith(rootDir: string, input: LangSmithSetupInput): LangSmithSetupResult {
  const apiKey = input.apiKey.trim();
  const project = input.project.trim();
  const endpoint = input.endpoint?.trim();
  if (!apiKey) throw new Error('LangSmith API key is required.');
  if (!project) throw new Error('LangSmith project is required.');

  const configPath = getLangSmithConfigPath(rootDir);
  if (fs.existsSync(configPath)) {
    throw new Error(`LangSmith configuration already exists at ${configPath}.`);
  }

  const lines = [
    '# Umbra local LangSmith configuration. This file is ignored by Git.',
    `LANGSMITH_TRACING=${quoteEnv('true')}`,
    `LANGSMITH_API_KEY=${quoteEnv(apiKey)}`,
    `LANGSMITH_PROJECT=${quoteEnv(project)}`,
  ];
  if (endpoint) lines.push(`LANGSMITH_ENDPOINT=${quoteEnv(endpoint)}`);

  fs.mkdirSync(agentPath(rootDir), { recursive: true });
  fs.writeFileSync(configPath, `${lines.join('\n')}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  return { path: configPath };
}
