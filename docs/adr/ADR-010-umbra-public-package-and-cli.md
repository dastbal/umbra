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

---

## Amendment — 2026-08-25

Two facts about the CLI surface described here changed on the same day, as part of
[ADR-011](./ADR-011-path-containment-and-real-approval.md).

**1. The root command no longer runs the graph pipeline.** `umbra "<instruction>"`
and `umbra chat` built `GraphAgentFactory`, while this ADR and the README present
`umbra deep`, `umbra orchestrate`, and `umbra analyze` as the product surface. The
undocumented default therefore routed a new user's first command into the legacy
path — the same path that contained the unguarded `analyzeCodeStructureTool` read.
Both now route to `DeepAgentFactory` with `ChatSession`.

The legacy modes are **not** removed, because v2.0.0 published them: `umbra graph`,
`umbra classic`, and the new `umbra chat --legacy` reach them, each printing a
deprecation notice through `warnDeprecatedMode`. `umbra graph` previously
delegated to the root command and now calls `runGraphMode` directly — delegating
would have silently sent it to the Deep Agent.

**2. `tsconfig.build.json` was never versioned.** This ADR states the publish
build uses it, and it does — but the repository's `.gitignore` excluded it with a
blanket `*.json` rule, so `npm run build` could not work in a fresh clone. The
rule is now an explicit list of sensitive patterns. The file itself still needs to
be committed; see ADR-011.

Related files added by the amendment:

- `src/bin/cli.ts` — `runGraphMode`, `runGraphChat`, `warnDeprecatedMode`.
- `.gitignore` — explicit patterns replacing the blanket `*.json` rule.
