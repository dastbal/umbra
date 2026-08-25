# Migrating to Umbra 2.0

## Purpose

Version 2 renames the public package and CLI from the former NestJS AI Agent
identity to Umbra. The security-policy breaking changes remain part of this
major release.

## Package and command mapping

| Previous | Umbra 2.0 |
| --- | --- |
| `@dastbal/nestjs-ai-agent` | `@dastbal/umbra` |
| `agent` | `umbra` |
| `npm run agent -- deep` | `umbra deep` |
| `gcloud auth application-default login --project <project-id>` | `umbra auth login --project <project-id>` |

Install the new package globally after it is published:

```powershell
npm install -g @dastbal/umbra
umbra doctor
```

## Google authentication

For local development, run `umbra auth login --project <project-id>`. Umbra
asks for confirmation and then launches the official Google Cloud CLI. The
resulting Application Default Credentials remain in the operating system's
Google Cloud configuration; Umbra does not copy, print, or commit tokens.

For CI or non-interactive production environments, keep using
`GOOGLE_APPLICATION_CREDENTIALS` with a service-account key provided by the
deployment secret manager.

## Publishing and repository migration

The npm package name cannot be renamed in place. Publish the new public package
as `@dastbal/umbra@2.0.0`; retain the older package only as a deprecated
historical release. Rename the GitHub repository to `umbra` and update the
local Git remote after the GitHub rename is complete.
