import * as fs from 'fs';
import * as path from 'path';
import { McpPromptDescriptor, McpPromptResult } from './mcp.contracts';

/**
 * Umbra's shipped working guides, published as MCP prompts.
 *
 * ## Why this is the cheapest win in ADR-024
 *
 * `skills/*.md` already travels with the package: `package.json#files` is
 * `["dist", "skills/*.md", "README.md"]` (ADR-012). Until now those guides were
 * readable only by Umbra's own agent. As MCP prompts they become invocable by
 * any client — one guide written once, four agents using it, which is the same
 * consolidation the global constitution did for instructions on 2026-08-21.
 *
 * No parsing, no transformation, no model: a prompt is a file read from disk.
 *
 * ## Where they are read from
 *
 * The package's own `skills/` directory, resolved relative to this compiled
 * file — **not** the served repository. The guides are Umbra's, and a served
 * project is not expected to carry a copy. `umbra init` scaffolds them into a
 * consumer project separately; that copy is the consumer's to edit and is not
 * what this publishes.
 */

/** Directory name holding the shipped guides. */
const SKILLS_DIR_NAME = 'skills';

/** One prompt, described and readable. */
export interface PublishedPrompt {
  readonly descriptor: McpPromptDescriptor;
  readonly read: () => McpPromptResult;
}

/**
 * Locates the package's `skills/` directory.
 *
 * Walks up from this module: under `ts-node` the file sits at
 * `src/presentation/mcp/`, and in the build at `dist/presentation/mcp/`. Both
 * are three levels below the package root, but the walk is done by looking for
 * the directory rather than by counting, so a change to the output layout does
 * not silently publish nothing.
 *
 * @returns The absolute path, or `undefined` when the directory is absent.
 */
export function locateSkillsDirectory(): string | undefined {
  let current = __dirname;

  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = path.join(current, SKILLS_DIR_NAME);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return undefined;
}

/**
 * Assembles the prompt catalog from the shipped guides.
 *
 * A missing or unreadable directory yields an empty catalog rather than an
 * error: the three read-only tools are the server's reason to exist, and the
 * guides are a bonus. An empty `prompts/list` is honest; refusing to start
 * would not be.
 *
 * @returns The prompts to publish, sorted by name.
 */
export function buildPromptCatalog(): PublishedPrompt[] {
  const skillsDir = locateSkillsDirectory();
  if (skillsDir === undefined) return [];

  let entries: string[];
  try {
    entries = fs.readdirSync(skillsDir);
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.endsWith('.md'))
    .sort()
    .map((entry) => buildPrompt(path.join(skillsDir, entry), entry))
    .filter((prompt): prompt is PublishedPrompt => prompt !== undefined);
}

/**
 * Builds one prompt from a guide file.
 *
 * @param filePath - Absolute path to the guide.
 * @param fileName - The file's name, used to derive the prompt name.
 * @returns The prompt, or `undefined` when the file cannot be read.
 */
function buildPrompt(filePath: string, fileName: string): PublishedPrompt | undefined {
  let body: string;
  try {
    body = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return undefined;
  }

  const name = fileName.replace(/\.md$/, '');

  return {
    descriptor: {
      name,
      description: firstHeadingOrLine(body) ?? `Umbra working guide: ${name}`,
    },
    read: () => ({
      description: `Umbra working guide: ${name}`,
      messages: [{ role: 'user', content: { type: 'text', text: body } }],
    }),
  };
}

/**
 * Derives a one-line description from a guide's own first heading.
 *
 * Taken from the document rather than invented, so a guide that is rewritten
 * cannot end up advertised by a stale summary.
 *
 * @param body - The guide's full text.
 * @returns The description, or `undefined` when none can be derived.
 */
function firstHeadingOrLine(body: string): string | undefined {
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    const heading = trimmed.replace(/^#+\s*/, '').trim();
    if (heading.length > 0) return heading.slice(0, 200);
  }

  return undefined;
}
