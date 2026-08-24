---
name: run-nestjs-ai-agent
description: Run, evaluate, and close changes to the local NestJS AI coding agent from this repository. Use when executing agent sessions, sending investigation prompts, validating TypeScript/Jest, checking Google Vertex AI authentication, measuring behavior or performance, or documenting agent-behavior decisions in ADRs.
---

# Run the NestJS AI Agent

Use this skill as the canonical execution workflow for this repository. Work from the repository root:

`C:\Users\BLUELABEL-PROGRAMMER\Documents\london\London\nestjs-ai-agent-lib`

## Select the execution mode

For an interactive session, use the project command first:

```powershell
npm run agent -- deep
```

If `npm` is unavailable in the execution environment, use the equivalent local command:

```powershell
node -r ts-node/register src/bin/cli.ts deep
```

The interactive prompt appears as `You:`. Type the task there. Use a named session when the conversation must be resumed:

```powershell
npm run agent -- deep --session project-review
```

For one request that prints a final response and exits, use `classic`:

```powershell
node -r ts-node/register src/bin/cli.ts classic "Analyze the project architecture and cite concrete files"
```

Do not use `classic` to evaluate the streaming `deep` experience; it exercises the legacy factory. Use `deep` for the active implementation and `classic` only for short, non-interactive diagnostics.

## Run the baseline checks

Before evaluating behavior or changing code, run:

```powershell
npm run type-check
npm test -- --runInBand
```

If the environment's global `npm` is broken, run the local binaries:

```powershell
node node_modules/typescript/bin/tsc --noEmit
node node_modules/jest/bin/jest.js --runInBand --forceExit
```

Record TypeScript status, Jest suite/test counts, elapsed time, and any open-handle warning. Do not claim a performance improvement from a single run; compare repeated runs with the same prompt and model.

For a model comparison, first make sure the index is up to date, then run the
same one-shot prompt once per model. Record completion/failure, tool or turn
loops, elapsed time, cited-evidence quality, and unknowns. Do not compare a
cold-index run against a warm-index run as if it were a pure model benchmark.

## Google Vertex AI and Ollama

Read `.env` without printing secret values. Confirm `AGENT_MODEL` and whether `GOOGLE_APPLICATION_CREDENTIALS` points to an existing file.

When using a configured credentials JSON file, do not run Google login automatically. If Application Default Credentials are required, the user can run:

```powershell
gcloud auth application-default login
```

The agent sends project context to Google when using Gemini/Vertex AI. Ask for explicit user authorization before invoking an external model with private repository content. Prefer Ollama only when it is installed and the user wants local inference.

## Evaluation prompts

For a diagnostic pass, ask the agent for evidence-based answers in separate sections:

```text
Evaluate this project in three parts: (1) purpose and real architecture, (2) three prioritized risks with exact files, and (3) performance and cost. Use evidence from files; do not guess.
```

Check the response against the files yourself. Flag claims using “probably” or “suggests” when the source can be inspected directly. In particular, verify whether embeddings use Vertex AI, whether the active `deep` path tracks cost, and whether the cited tools are actually registered in the selected factory.

## ADR history

Do not load every file in `docs/adr/` by default. When a task needs a prior
architecture decision, model policy, safety boundary, or project-history fact,
call `list_adrs` first. Read only the ADR selected by its identifier, title,
status, and compact context. Use `refresh: true` only after ADR files changed.

## Safe execution rules

- Do not modify files merely to run an evaluation.
- Do not expose `.env`, credential JSON, LangSmith keys, or token payloads in output.
- Treat agent-generated claims as hypotheses until verified against source files.
- If the agent requests writes, deletions, infrastructure changes, or external operations, report the proposed action and obtain user approval when required.
- Preserve the distinction between active `DeepAgentFactory` behavior and legacy `AgentFactory`/graph behavior.

## Close an agent behavior change

When a change affects model routing, prompts, tools, context, RAG, memory,
sessions, permissions, safety, costs, or evaluation behavior, always close it
with an ADR before calling the work finished.

1. Read the latest file in `docs/adr/` and create the next sequential
   `ADR-XXX-<decision>.md`. Never rewrite an accepted ADR to hide a later
   decision; create a new one that references it.
2. Include: status/date, context and observed failure, decision, rejected
   alternative, validation evidence, measurements with their limitations, and
   operational consequences.
3. Never put `.env` values, credentials, prompts containing private code, raw
   token payloads, or billing secrets in the ADR.
4. Update `README.md` if a command, model precedence, safety boundary, or
   analysis scope changed.
5. Run `tsc --noEmit`, Jest, and `git diff --check`. For a behavioral claim,
   execute the smallest real scenario that validates it; request explicit
   authorization before sending repository context to an external model.
6. In the final handoff, report what changed, the exact verification result,
   the measured limitation, and the recommended command for the user.
