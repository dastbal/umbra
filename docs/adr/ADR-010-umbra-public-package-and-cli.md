# ADR-010: Adopt Umbra as the public package and CLI identity

**Category:** Product identity and distribution  
**Author:** David Balladares  
**Date:** 2026-08-25  

## Status

Accepted — 2026-08-25

## Context

The project is evolving from a NestJS-specific agent library into a secure,
customizable engineering orchestrator. The previous package and executable
names described the implementation but did not provide a distinct product
identity or a concise global command.

David selected **Umbra** as the product name. The breaking v2 security policy
is already planned as the release boundary, so the public rename belongs to the
same major version.

## Decision

The published package is `@dastbal/umbra` and its executable is `umbra`.
`package.json` exposes only the `umbra` binary; the former global `agent`
binary is intentionally not retained as a silent compatibility alias.

Umbra provides `auth login` and `auth status` commands for local Google
Application Default Credentials. `GoogleApplicationDefaultAuth` delegates the
interactive login to the official Google Cloud CLI after an explicit terminal
confirmation. `LLMProvider` accepts either local ADC or the existing
`GOOGLE_APPLICATION_CREDENTIALS` service-account configuration.

The publish build uses `tsconfig.build.json` so test source remains type-checked
by the repository while compiled test suites are excluded from the global npm
artifact.

## Consequences

- Global installation becomes `npm install -g @dastbal/umbra`, followed by
  `umbra` from the target workspace.
- Existing global `agent` users must migrate their shell commands deliberately.
- The original npm package remains a separate historical package because npm
  package names cannot be renamed in place.
- Google OAuth tokens remain owned by Google Cloud tooling and are never stored
  in Umbra configuration, telemetry, or documentation examples.

## Verification Evidence

- `node node_modules/typescript/bin/tsc --noEmit --pretty false` passed.
- `node node_modules/jest/bin/jest.js --runInBand --no-cache` passed: 25 suites
  and 89 tests.
- `node -r ts-node/register src/bin/cli.ts --help` displayed `umbra` and the
  `auth` command tree.
- `npm pack --dry-run --json` with an isolated local cache produced
  `@dastbal/umbra@2.0.0` with 170 files and zero compiled test files.

## Related Files

- `package.json` — `name`, `bin`, `scripts`.
- `src/bin/cli.ts` — `program`, `auth` command tree.
- `src/presentation/cli/google-application-default-auth.ts` — `GoogleApplicationDefaultAuth`.
- `src/core/llm/provider.ts` — `LLMProvider.hasVertexCredentials`, `ensureVertexCredentials`.
- `tsconfig.build.json` — production artifact exclusions.
- `docs/MIGRATING-TO-UMBRA.md` — package and command migration guide.
