/** Local, human-readable projection of privacy-scoped GraphRAG Detective facts. */

import type {
  DetectiveReplayResult,
  DetectiveTrace,
  RetrievalPolicyPromotion,
} from '../../core/rag/graphrag';
import { colors, formatDuration } from './theme';

/**
 * Renders a Detective comparison without printing source chunks or model output.
 *
 * @param trace - Local experiment to show.
 * @returns Terminal-ready diagnostic text.
 */
export function renderDetectiveTrace(trace: DetectiveTrace): string {
  const lines = [
    '',
    colors.secondary.bold(`  🕵️  GraphRAG Detective · ${trace.mode}`),
    colors.muted(`  trace ${trace.id} · index ${trace.indexFingerprint.slice(0, 12)}`),
    colors.muted(`  question: ${trace.query}`),
    colors.muted(
      `  budget: ${trace.budget.maxSeeds} seeds · depth ${trace.budget.maxDepth} · ` +
      `${trace.budget.maxNodes} nodes · ${trace.budget.maxRelations} relations · ` +
      `${trace.budget.maxChunks} chunks · ~${trace.budget.maxEstimatedTokens} tokens`,
    ),
    '',
  ];
  for (const plan of trace.plans) {
    const accepted = plan.branches.filter((branch) => branch.outcome === 'accepted').length;
    const discarded = plan.branches.length - accepted;
    const status = plan.eligible ? colors.accent('eligible') : colors.warning('skipped');
    lines.push(`  ${colors.primary.bold(plan.plan.padEnd(14))} ${status}`);
    if (!plan.eligible) lines.push(colors.muted(`    ${plan.reason ?? 'Graph projection unavailable.'}`));
    lines.push(colors.muted(
      `    depth ${plan.metrics.depthReached} · nodes ${plan.metrics.nodesVisited} · ` +
      `relations ${plan.metrics.relationsInspected} · branches +${accepted}/-${discarded} · ` +
      `context ~${plan.metrics.estimatedTokens} tokens · ${formatDuration(plan.elapsedMs)}`,
    ));
    lines.push(colors.muted(
      `    budget use: nodes ${plan.metrics.nodesVisited}/${trace.budget.maxNodes} · ` +
      `relations ${plan.metrics.relationsInspected}/${trace.budget.maxRelations} · ` +
      `chunks ${plan.selectedEvidence.length}/${trace.budget.maxChunks}`,
    ));
    const hopReceipt = plan.metrics.marginalEvidence.map((hop) =>
      `d${hop.depth}: +${hop.novelEvidence} evidence / ${hop.relationsInspected} relations`,
    );
    lines.push(colors.muted(
      `    stop: ${plan.metrics.stopReason} · receipt: ${hopReceipt.join(' · ') || 'no graph expansion'}`,
    ));
    const evidence = plan.selectedEvidence.map((item) =>
      `${item.path} (${item.origin}, ${item.score.toFixed(2)})`,
    );
    lines.push(colors.muted(`    evidence: ${evidence.join(', ') || 'none'}`));
    const branchPreview = plan.branches.slice(0, 6).map((branch) =>
      `${branch.from} -[${branch.relation}]-> ${branch.to} (${branch.outcome})`,
    );
    if (branchPreview.length > 0) {
      lines.push(colors.muted(`    branches: ${branchPreview.join(' · ')}${plan.branches.length > 6 ? ' · …' : ''}`));
    }
    lines.push(colors.muted(renderQuality(plan.quality)));
    lines.push(colors.muted(`    next: ${plan.recommendation.reason}`));
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Renders whether a replay was comparable before showing any delta.
 *
 * @param replay - Previous and current experiment pair.
 * @returns Terminal-ready replay report.
 */
export function renderDetectiveReplay(replay: DetectiveReplayResult): string {
  if (!replay.comparable) {
    return [
      '',
      colors.warning('  ⚠️  Detective replay ran, but no direct comparison is valid.'),
      colors.muted(`  ${replay.reason ?? 'The indexed corpus changed.'}`),
      colors.muted(`  previous ${replay.previous.indexFingerprint.slice(0, 12)} · current ${replay.current.indexFingerprint.slice(0, 12)}`),
      '',
    ].join('\n');
  }
  const lines = ['', colors.accent('  ✅ Detective replay is comparable: identical index fingerprint.')];
  for (const previous of replay.previous.plans) {
    const current = replay.current.plans.find((plan) => plan.plan === previous.plan);
    if (current === undefined) continue;
    const latencyDelta = current.elapsedMs - previous.elapsedMs;
    const evidenceDelta = current.selectedPaths.length - previous.selectedPaths.length;
    lines.push(colors.muted(
      `  ${previous.plan}: ${formatSigned(evidenceDelta)} selected paths · ${formatSigned(latencyDelta)}ms`,
    ));
    if (previous.quality.sampleSize === 0 || current.quality.sampleSize === 0) {
      lines.push(colors.muted('    quality: unavailable for an unlabelled free-form question'));
    } else {
      lines.push(colors.muted(
        `    quality: Hit@1 ${previous.quality.hitAt1} → ${current.quality.hitAt1} · ` +
        `MRR ${previous.quality.mrr} → ${current.quality.mrr}`,
      ));
    }
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Renders the evidence and result of an explicit local policy promotion.
 *
 * @param promotion - Promotion outcome from the deterministic kernel.
 * @returns Terminal-ready policy message.
 */
export function renderPolicyPromotion(promotion: RetrievalPolicyPromotion): string {
  if (!promotion.promoted) {
    return [
      '',
      colors.warning(`  ⚠️  ${promotion.policy} was not promoted.`),
      colors.muted(`  ${promotion.reason ?? 'No compatible local evidence was found.'}`),
      '',
    ].join('\n');
  }
  return [
    '',
    colors.accent(`  ✅ Promoted ${promotion.policy} locally.`),
    colors.muted(`  Evidence: Detective trace ${promotion.trace?.id ?? 'unknown'} on the current index.`),
    '',
  ].join('\n');
}

/** Formats a numeric comparison without pretending a zero is a direction. */
function formatSigned(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

/** Formats quality only when the trace has a repository-owned ground-truth label. */
function renderQuality(quality: DetectiveTrace['plans'][number]['quality']): string {
  if (quality.sampleSize === 0) return '    quality: unavailable; this free-form question has no labelled oracle';
  return `    quality: ${quality.corpusCaseId} · Hit@1 ${quality.hitAt1} · MRR ${quality.mrr} · ` +
    `false abstention ${quality.falseAbstention} · correct abstention ${quality.correctAbstention}`;
}
