/**
 * @module NestGraphTools
 *
 * The read-only tool that answers NestJS wiring questions.
 *
 * ## Why a separate tool from `query_dependency_graph`
 *
 * That tool takes a file path and a direction, because file imports are a
 * relation between two files. Nest wiring is not: it is a relation between a
 * **module** and a **token**, and the token is frequently a string constant
 * that belongs to no file at all. Overloading one schema to carry both would
 * mean a `filePath` argument that sometimes is not a path, which is the kind of
 * contract a model gets wrong in exactly the cases that matter.
 *
 * Both tools stay published. They answer different questions, and the file one
 * remains the right answer for "what breaks if I move this file".
 */

import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { AgentDB } from '../state/db';
import {
  findBindingsForModule,
  findBindingsForToken,
  findInjectionsForToken,
  normalizeToken,
} from '../rag/nest-graph-store';
import { log } from './utils/logger';
import { executeNestGraph, formatNestGraphForModel } from './read-only-executions';

/** What the caller wants to know about a name. */
export type NestGraphDirection = 'provides' | 'injects' | 'module';

/**
 * The verb for each binding kind.
 *
 * Naive pluralization produced "AiAgentModule **providers** it", which reads as
 * a typo and undermines a report whose whole job is to be trusted about wiring.
 */
const BINDING_VERB: Readonly<Record<string, string>> = {
  import: 'imports',
  provider: 'provides',
  controller: 'declares as a controller',
  export: 'exports',
};

/**
 * Pluralizes a count without the `(s)` that makes a report look generated.
 *
 * @param count - How many.
 * @param singular - The singular noun.
 * @param plural - The plural noun.
 * @returns `"1 binding"` or `"2 bindings"`.
 */
function countOf(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * Renders the modules that bind a token.
 *
 * @param token - Token as the caller typed it.
 * @returns A report, or an explicit absence.
 */
function renderProviders(token: string): string {
  const db = AgentDB.getInstance();
  const bindings = findBindingsForToken(db, token);
  if (bindings.length === 0) {
    return `ℹ️ No module in this repository binds \`${normalizeToken(token)}\`.`;
  }

  const lines = bindings.map((binding) => {
    const how = binding.useKind === undefined ? '' : ` (${binding.useKind})`;
    // Whether a binding came from a `forRoot` is load-bearing for the reader:
    // it means the token exists only when that module was registered with
    // options, which is a different debugging story from an always-on provider.
    const when = binding.dynamic ? ' — only when registered dynamically' : '';
    const verb = BINDING_VERB[binding.kind] ?? binding.kind;
    return `- ${binding.module} **${verb}** it${how}${when}\n  ${binding.filePath}`;
  });

  const summary = countOf(bindings.length, 'binding', 'bindings');
  return `🧩 **${normalizeToken(token)}** is bound by ${summary}:\n\n${lines.join('\n')}`;
}

/**
 * Renders the classes that ask for a token.
 *
 * @param token - Token as the caller typed it.
 * @returns A report, or an explicit absence.
 */
function renderConsumers(token: string): string {
  const db = AgentDB.getInstance();
  const injections = findInjectionsForToken(db, token);
  if (injections.length === 0) {
    return `ℹ️ Nothing in this repository injects \`${normalizeToken(token)}\`.`;
  }

  const lines = injections.map((injection) => {
    const how = injection.explicit ? '@Inject' : 'by type';
    return `- ${injection.consumer} (${how})\n  ${injection.filePath}`;
  });

  return [
    `🧩 **${normalizeToken(token)}** is injected by ${countOf(injections.length, 'class', 'classes')}.`,
    'These are what break if it stops being provided or exported:',
    '',
    lines.join('\n'),
  ].join('\n');
}

/**
 * Renders everything one module binds.
 *
 * @param module - Module class name.
 * @returns A report, or an explicit absence.
 */
function renderModule(module: string): string {
  const db = AgentDB.getInstance();
  const bindings = findBindingsForModule(db, module);
  if (bindings.length === 0) {
    return `ℹ️ No module named \`${module}\` was found, or it binds nothing.`;
  }

  const byKind = new Map<string, string[]>();
  for (const binding of bindings) {
    const how = binding.useKind === undefined ? '' : ` (${binding.useKind})`;
    const entry = `${binding.token}${how}${binding.dynamic ? ' [dynamic]' : ''}`;
    byKind.set(binding.kind, [...(byKind.get(binding.kind) ?? []), entry]);
  }

  const sections = [...byKind.entries()].map(
    ([kind, tokens]) => `**${kind}s**: ${tokens.join(', ')}`,
  );

  return [
    `🧩 **${module}** (${bindings[0].filePath})`,
    '',
    ...sections,
  ].join('\n');
}

export const queryNestGraphTool = tool(
  async ({ name, direction }) => {
    log.debug(`query_nest_graph called for: ${name} [${direction}]`);
    const result = executeNestGraph({ name, direction });
    if (result.status === 'error') log.error(`Failed to query the Nest graph: ${result.diagnostics[0].message}`);
    return [formatNestGraphForModel(result), result] as const;
  },
  {
    name: 'query_nest_graph',
    description:
      'Answers NestJS dependency-injection questions that a file-import graph cannot: ' +
      'which module provides a token, which classes inject it, and what one module binds. ' +
      'Works for string tokens such as AI_AGENT, and for modules whose wiring lives in a ' +
      'forRoot() rather than in the @Module decorator.',
    schema: z.object({
      name: z
        .string()
        .min(1)
        .describe('An injection token (AI_AGENT) or a module class name (UsersModule).'),
      direction: z
        .enum(['provides', 'injects', 'module'])
        .describe(
          'provides = modules that bind this token; injects = classes that ask for it; ' +
            'module = everything the named module binds.',
        ),
    }),
    responseFormat: 'content_and_artifact',
  },
);
