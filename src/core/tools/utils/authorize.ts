import { AgentSecurityPolicy, type AgentActionKind, type PolicyEvaluation } from '../../security';

/**
 * Single policy instance shared by every tool.
 *
 * The policy is stateless, so one instance is enough — and a single instance
 * makes it obvious that no tool can be handed a weakened copy.
 */
const securityPolicy = new AgentSecurityPolicy();

/**
 * Evaluates a filesystem tool request without performing it.
 *
 * Every tool that touches the disk must call this before the side effect. Tools
 * that need the human approval flow inspect `decision === 'require_approval'`
 * themselves; tools that cannot ask simply refuse anything that is not `allow`.
 *
 * @param kind - The category of side effect being requested.
 * @param rootDir - The workspace root that bounds the action.
 * @param filePath - The untrusted path requested by the model.
 * @returns The policy verdict, safe to show to a user.
 */
export function evaluateFileAction(
  kind: AgentActionKind,
  rootDir: string,
  filePath: string,
): PolicyEvaluation {
  return securityPolicy.evaluate({ kind, rootDir, targetPath: filePath });
}

/**
 * Formats a non-`allow` verdict as a tool result, without leaking internals.
 *
 * @param evaluation - The verdict returned by {@link evaluateFileAction}.
 * @returns The message to return to the model.
 */
export function formatAuthorizationFailure(evaluation: PolicyEvaluation): string {
  const prefix = evaluation.decision === 'deny' ? 'DENIED' : 'APPROVAL_REQUIRED';
  return `❌ ${prefix}: ${evaluation.reason}`;
}

/**
 * Evaluates a filesystem request and formats a refusal when it is not allowed.
 *
 * Convenience wrapper for tools with no approval channel of their own.
 *
 * @param kind - The category of side effect being requested.
 * @param rootDir - The workspace root that bounds the action.
 * @param filePath - The untrusted path requested by the model.
 * @returns A refusal message, or `undefined` when the action may proceed.
 */
export function authorizeFileAction(
  kind: AgentActionKind,
  rootDir: string,
  filePath: string,
): string | undefined {
  const evaluation = evaluateFileAction(kind, rootDir, filePath);
  if (evaluation.decision === 'allow') return undefined;
  return formatAuthorizationFailure(evaluation);
}
