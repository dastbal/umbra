import { buildAdrIndex, formatAdrIndex } from '../../core/tools/adr-index';
import { readIndexStamp } from '../../core/rag/index-stamp';
import {
  McpResourceContents,
  McpResourceDescriptor,
} from './mcp.contracts';

/**
 * Resources this server exposes: cached catalogs a client can read without
 * spending a tool call.
 *
 * ## What is published, and what ADR-024 expected
 *
 * ADR-024's table lists two resources — "ADR index, README index … the cached
 * catalogs in `.umbra/` (ADR-003, ADR-004)". Only the first exists.
 *
 * `list_readmes`, the subject of ADR-003 and recorded there as Accepted, has no
 * implementation in `src/`: no tool, no index builder, no cache writer. The
 * README index is therefore **not** published here, because publishing a
 * resource this repository cannot produce is the same defect as advertising a
 * tool that cannot answer.
 *
 * Per `AGENTS.md`: the code is authoritative for what the system does now, the
 * record for why it was built that way, and a disagreement between them means
 * the record needs an amendment. That amendment is owed to ADR-003 and is noted
 * in ADR-024's evidence rather than papered over here.
 */

/** URI scheme for Umbra's own resources. */
const UMBRA_SCHEME = 'umbra://';

/** The ADR catalog resource URI. */
export const ADR_INDEX_URI = `${UMBRA_SCHEME}adr-index`;

/** The index provenance resource URI. */
export const INDEX_STATUS_URI = `${UMBRA_SCHEME}index-status`;

/** One resource, described and readable. */
export interface PublishedResource {
  readonly descriptor: McpResourceDescriptor;
  readonly read: () => McpResourceContents;
}

/**
 * Assembles the resource catalog for a pinned repository root.
 *
 * @param rootDir - The repository this server serves.
 * @returns The resources to publish.
 */
export function buildResourceCatalog(rootDir: string): PublishedResource[] {
  return [
    {
      descriptor: {
        uri: ADR_INDEX_URI,
        name: 'Architectural Decision Records — index',
        description:
          'Path, title, status and compact context for every ADR in this repository, without their ' +
          'bodies. The cheapest way to learn why the code is shaped the way it is.',
        mimeType: 'text/markdown',
      },
      read: () => ({
        uri: ADR_INDEX_URI,
        mimeType: 'text/markdown',
        text: formatAdrIndex(buildAdrIndex(rootDir)),
      }),
    },
    {
      descriptor: {
        uri: INDEX_STATUS_URI,
        name: 'Semantic index status',
        description:
          'Which embedding provider built the code index, when, over how many files, and whether it ' +
          'is complete. Read this before trusting a semantic search answer.',
        mimeType: 'text/plain',
      },
      read: () => ({
        uri: INDEX_STATUS_URI,
        mimeType: 'text/plain',
        text: describeIndexStatus(rootDir),
      }),
    },
  ];
}

/**
 * Renders what is known about the semantic index.
 *
 * An absent stamp is reported as absent. Reporting a default would be the
 * ADR-017 failure again: a confident line over an index nobody verified.
 *
 * @param rootDir - The repository to inspect.
 * @returns A human- and model-readable status.
 */
function describeIndexStatus(rootDir: string): string {
  const stamp = readIndexStamp(rootDir);

  if (stamp === undefined) {
    return (
      'No semantic index stamp found. Either the index was never built, or it was built before ' +
      'index provenance was recorded. Semantic search may be unavailable or incomplete.'
    );
  }

  const lines = [
    `provider:      ${stamp.provider}`,
    `model:         ${stamp.model}`,
    `dimensions:    ${stamp.dimensions}`,
    `indexed at:    ${new Date(stamp.indexedAt).toISOString()}`,
    `files indexed: ${stamp.filesIndexed}`,
    `status:        ${stamp.status}`,
  ];

  if (stamp.status === 'partial') {
    lines.push(
      '',
      'WARNING: some files failed to embed. Semantic search will not find them. ' +
        'This is reported rather than hidden, because an incomplete index that claims success is ' +
        'worse than a visible failure.',
    );
  }

  if (stamp.status === 'empty') {
    lines.push('', `UNAVAILABLE: ${stamp.diagnostic ?? 'No indexable source files were discovered.'}`);
  }

  return lines.join('\n');
}
