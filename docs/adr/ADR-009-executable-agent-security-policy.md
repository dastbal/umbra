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
