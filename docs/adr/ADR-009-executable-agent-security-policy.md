# ADR-009: Enforce agent tool authorization in code

## Status

Accepted — 2026-08-25

## Context

The agent can modify a real workspace. Earlier protections were split between
prompts, a small shell blacklist, and path checks based on string prefixes.
Those mechanisms could not consistently protect the Deep, classic, graph, and
NestJS entry points from sensitive files or symlink escapes.

## Decision

`AgentSecurityPolicy` evaluates every filesystem and verification action before
execution. It returns `allow`, `require_approval`, or `deny` with a safe reason.
The policy denies credentials, `.env*`, `.git`, workspace escapes, and arbitrary
shell execution; it requires approval for deletes and configuration changes; it
allows source, test, and documentation writes.

Path authorization uses `relative` plus real-path checks for existing parents.
Typed test and type-check tools use checkout-local Node binaries rather than
global `npm` or `npx`.

## Consequences

- A model cannot bypass tool policy with a more persuasive prompt.
- Existing classic and graph consumers receive stricter outcomes for destructive
  operations and must migrate to approval-aware flows.
- Automated operations remain available only through fixed verification tools.

## Verification Evidence

- `node node_modules/typescript/bin/tsc --noEmit --pretty false` passed.
- `node node_modules/jest/bin/jest.js --runInBand --no-cache` passed: 23 suites
  and 85 tests.

## Related Files

- `src/core/security/agent-security-policy.ts` — `AgentSecurityPolicy`,
  `resolveWorkspacePath`.
- `src/core/tools/file-tools.ts` — `safeWriteFileTool`, `safeReadFileTool`,
  `deleteFileTool`.
- `src/core/tools/testing-tools.ts` — `executeTestsTool`, `integrityCheckTool`.
- `src/core/tools/system-tools.ts` — `executeCommandTool`.

---

## Amendment — 2026-08-25

An audit the same day found that two statements above described the intent of
this decision rather than its implementation. Both are corrected by
[ADR-011](./ADR-011-path-containment-and-real-approval.md); the original text is
kept as written, because what was believed at the time is the point of the
record.

**1. "Path authorization uses `relative` plus real-path checks for existing
parents."** Accurate, and that was the gap: only the *parent* was resolved. A
link in the final component (`src/notes.txt -> ../../.env`) kept a legitimate
parent and was followed. The Context above claims protection "from sensitive
files or symlink escapes" — that held for a link in parent position, not in final
position. Additionally `analyzeCodeStructureTool` called no policy at all, so the
claim that the policy "evaluates every filesystem and verification action" was
not true of that tool.

**2. "it requires approval for deletes and configuration changes"** — the verdict
was produced but never consumed. Every tool rendered `require_approval` as an
error string, so `deleteFileTool` could not succeed under any circumstance and
writes outside `src|test|docs` always failed. The human channel
(`ChatSession#handleHITL`) existed independently and was never wired to this
policy.

That this policy was written before its approval channel existed is the reason
the gap survived a release: the verdict looked implemented because the enum had
three members. ADR-011 supplies `requestApproval` as the consumer.

Related files added by the amendment:

- `src/core/tools/utils/authorize.ts` — `evaluateFileAction`,
  `formatAuthorizationFailure`, `authorizeFileAction`.
- `src/core/tools/utils/approval.ts` — `requestApproval`.
- `src/core/tools/analysis-tools.ts` — `analyzeCodeStructureTool`.
