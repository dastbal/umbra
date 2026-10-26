/** The retrieval signals that can justify a returned code chunk. */
export type RetrievalEvidence = 'semantic' | 'lexical' | 'hybrid';

/** Candidate information used only for rank fusion. */
export interface RankedCandidate {
  readonly id: string;
  readonly lexicalExact: boolean;
}

/** A candidate after semantic and lexical rankings have been fused. */
export interface HybridCandidate {
  readonly id: string;
  readonly evidence: RetrievalEvidence;
  readonly lexicalExact: boolean;
  readonly score: number;
}

/** A retrieved candidate with the source role needed for final presentation order. */
export interface ExecutableEvidenceCandidate {
  readonly id: string;
  readonly type: string;
  readonly score: number;
  readonly evidence: RetrievalEvidence;
}

const RRF_K = 60;

/**
 * Fuses independent rankings by Reciprocal Rank Fusion.
 *
 * Rank positions, rather than raw BM25 or cosine values, are combined. This
 * keeps the provider-specific vector space and the lexical score in their own
 * domains.
 *
 * @param semantic - Candidates ordered by semantic relevance.
 * @param lexical - Candidates ordered by lexical relevance.
 * @param limit - Maximum fused candidates to return.
 * @returns Fused candidates, highest RRF score first.
 */
export function fuseRankings(
  semantic: readonly RankedCandidate[],
  lexical: readonly RankedCandidate[],
  limit: number,
): readonly HybridCandidate[] {
  const candidates = new Map<
    string,
    { semanticRank?: number; lexicalRank?: number; lexicalExact: boolean }
  >();

  semantic.forEach((candidate, index) => {
    candidates.set(candidate.id, { semanticRank: index + 1, lexicalExact: false });
  });

  lexical.forEach((candidate, index) => {
    const existing = candidates.get(candidate.id);
    candidates.set(candidate.id, {
      semanticRank: existing?.semanticRank,
      lexicalRank: index + 1,
      lexicalExact: candidate.lexicalExact || existing?.lexicalExact === true,
    });
  });

  return [...candidates.entries()]
    .map(([id, candidate]) => {
      const score =
        (candidate.semanticRank === undefined ? 0 : 1 / (RRF_K + candidate.semanticRank)) +
        (candidate.lexicalRank === undefined ? 0 : 1 / (RRF_K + candidate.lexicalRank));
      const evidence: RetrievalEvidence =
        candidate.semanticRank !== undefined && candidate.lexicalRank !== undefined
          ? 'hybrid'
          : candidate.lexicalRank !== undefined
            ? 'lexical'
            : 'semantic';

      return { id, evidence, lexicalExact: candidate.lexicalExact, score };
    })
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, limit);
}

/**
 * Applies Umbra's portable abstention policy.
 *
 * A semantic-only nearest neighbour is not evidence by itself. The result set
 * must contain either independent lexical agreement or a direct route/symbol
 * match before the agent is shown source material.
 *
 * @param candidates - Final, fused candidates presented to the caller.
 * @returns Whether the result set is grounded enough to display.
 */
export function hasGroundedEvidence(
  candidates: readonly Pick<HybridCandidate, 'evidence' | 'lexicalExact'>[],
): boolean {
  return candidates.some(
    (candidate) => candidate.evidence === 'hybrid' || candidate.lexicalExact,
  );
}

/**
 * Orders already-grounded evidence so executable behaviour is shown before a
 * class outline whose TSDoc or decorators merely describe that behaviour.
 *
 * This deliberately runs after hybrid fusion: it never turns a semantic-only
 * neighbour into evidence and never compares BM25 with vector distances.
 *
 * @param candidates - Fused candidates paired with their indexed chunk role.
 * @returns A new array ordered for useful source presentation.
 */
export function preferExecutableEvidence<T extends ExecutableEvidenceCandidate>(
  candidates: readonly T[],
): readonly T[] {
  return [...candidates].sort((left, right) =>
    evidencePriority(right.evidence) - evidencePriority(left.evidence) ||
    executablePriority(right.type) - executablePriority(left.type) ||
    right.score - left.score ||
    left.id.localeCompare(right.id),
  );
}

/** Keeps stronger independent evidence ahead of a source-role preference. */
function evidencePriority(evidence: RetrievalEvidence): number {
  return { semantic: 1, lexical: 2, hybrid: 3 }[evidence];
}

/** Gives implementation bodies precedence over descriptive declaration context. */
function executablePriority(type: string): number {
  if (type === 'method' || type === 'function') return 3;
  if (type === 'file') return 2;
  if (type === 'class_signature') return 1;
  return 0;
}
