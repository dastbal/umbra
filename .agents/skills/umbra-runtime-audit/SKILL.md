---
name: umbra-runtime-audit
description: >
  Audits Umbra's real runtime quality, tool obedience, latency, token use, cost, telemetry, and
  model fitness without changing Umbra. Use in nestjs-ai-agent-lib when David says "auditá Umbra",
  "probá el agente", "reporte de performance", "auditoría de modelo", "compará Haiku con Gemini",
  "por qué se colgó", or "revisá la telemetría". Do NOT use to implement a fix, create a new Umbra
  feature, or merely plan tests; use the normal engineering flow, umbra-ideation, or test-architect instead.
---

# Umbra Runtime Audit

Audit the running CLI as an operator would experience it. This skill is project-local and personal:
it governs the assistant's audit work only. It must never alter Umbra's runtime behavior, package,
provider configuration, source, tests, ADRs, or shipped `skills/` directory unless David separately asks.

## Trigger

Use this skill only for an explicit runtime, performance, provider, model-comparison, reliability, or
telemetry audit of this repository. Treat a request to "fix", "implement", or "make it faster" as a
separate implementation task after the report; this skill reports and stops.

## Why this exists

Umbra's meaningful behavior happens in the compiled interactive Deep path, not in a static answer:
`src/bin/cli.ts` creates `DeepAgentFactory`, which drives `ChatSession` and its tool cycles. A passing
unit test cannot prove provider response timing, tool obedience, stream closure, or accumulated spend.

The audit must distinguish four things that are often conflated:

1. **Model quality** — accuracy, instruction obedience, evidence, and useful final answers.
2. **Runtime efficiency** — first response, elapsed time, tool count, token growth, and cost.
3. **Control effectiveness** — whether local gates and turn ceilings actually hold in a live path.
4. **Evidence confidence** — source-verified, telemetry-verified, or live-provider-verified.

Read `references/report-contract.md` before assembling the final report. It contains the scorecard,
safe telemetry rules, and model-selection method.

## Audit protocol

### Phase 0 — Establish the boundary

1. State that this is an audit and that no source/configuration changes will be made.
2. Read `docs/adr/README.md` first. Open only ADRs matching `models`, `provider`, `telemetry`,
   `limits`, `cost`, `prompt`, `cli`, or the reported symptom.
3. Inspect `git status --short` and preserve every unrelated change. Do not stage, commit, install,
   delete, reset, migrate, or start a service.
4. Decide the minimum evidence level needed. Static source and local telemetry are read-only. A real
   Vertex/Anthropic call may send repository-derived context externally: obtain explicit authorization
   for the exact number and scope of provider invocations before making one.

### Phase 1 — Collect the inexpensive evidence

1. Inspect the relevant current symbols, not broad source trees. For Deep, begin with
   `DeepAgentFactory.create`, `ChatSession.sendMessage`, `TurnAudit`, and the active budget middleware.
2. Aggregate `.umbra/telemetry/interactive-turns.jsonl` safely. Report counts, durations, outcomes,
   tool counts, model names, and aggregates only; never copy prompts, responses, tool arguments,
   credentials, raw errors, or private paths from telemetry.
3. Verify the configured pricing and model routing from source. Treat provider prices as volatile;
   distinguish the repository's configured estimate from a current provider quote.
4. Label every conclusion as **source-verified**, **telemetry-verified**, **live-verified**, or
   **not verified**. A prior run never upgrades a different model, prompt, or checkout to live proof.

### Phase 2 — Design the smallest live probe

Only after authorization, choose probes that isolate one claim at a time:

| Claim | Minimum probe | Success signal |
|---|---|---|
| Local conversation gate | greeting or thanks | no model/tool turn and immediate local reply |
| Tool obedience | one narrow read-only task with an exact tool ceiling | correct answer within the requested tool count |
| ADR/evidence flow | one targeted ADR lookup plus one source read | selected accepted ADR and symbols cited |
| Turn governor | an approved controlled boundary test | refusal/final synthesis at the declared ceiling |
| Model comparison | identical prompt corpus in fresh sessions | scorecard, not preference |

Use fresh named sessions or fresh processes for independent probes. Record wall time from the audit
record where available, then compare it with summed tool duration; do not call all remaining time
"model latency" when startup, indexing, or provider transport was not isolated.

### Phase 3 — Run and observe

1. Run only the approved probe count and model list. Stop a visibly stalled turn at the agreed timeout;
   report it as an interrupted/unfinished observation, never as a provider failure without evidence.
2. Keep the model at the requested reasoning setting. Record the model identifier, start mode, outcome,
   elapsed time, executed tools, tool duration, observed usage, and displayed spend when present.
3. After every live probe, read only the newly appended, privacy-safe telemetry/probe records.
4. Do not retry a failed provider call automatically. A retry is another external request and needs to
   fit the authorization count.

### Phase 4 — Compare models when requested

1. Use the same prompts, repository state, mode, reasoning level, and tool allowance for every model.
2. Score correctness and instruction obedience before time or cost. A cheap incorrect audit is not a win.
3. Separate a completed direct-answer turn from a completed tool-result round trip.
4. Recommend one default, one escalation model, and one explicitly unsupported option. Do not infer
   coding superiority from a single response or compare historical medians from different workloads.

### Phase 5 — Report and stop

Use the report contract. Lead with the operational verdict, then give the scorecard, verified findings
ranked by severity, model recommendation, data limitations, and a narrow next plan. Cite repository
evidence as `path#symbol`; cite telemetry by audit id and safe aggregate. Do not implement the plan.

## Guardrails

| Never | Instead |
|---|---|
| Treat a unit test or a process that merely starts as a live tool-cycle pass | Name the exact provider turn and whether it completed the requested cycle |
| Send repository-derived content to a provider because the user said "audit" | Obtain explicit authorization for the exact live call count and scope |
| Expose raw telemetry, prompts, responses, provider payloads, credentials, or full private paths | Report safe counts, durations, costs, model IDs, and anonymized audit identifiers |
| Claim a model is better from price, brand, or one anecdote | Compare equivalent tasks and score correctness/obedience first |
| Change source, model defaults, limits, ADRs, or package settings during an audit | Report the evidence and wait for a separate implementation request |
| Hide an aborted, stalled, or blocked run | Report it plainly with the observed boundary and what remains unverified |

## How to know this worked

The audit is complete only when all applicable checks hold:

1. It states the evidence level and provider authorization boundary.
2. Each finding has a mechanism and a concrete source symbol or safe telemetry record.
3. It separates live results from historical aggregates and unverified claims.
4. A model recommendation names the workload it fits and the validation still missing.
5. No repository behavior changed as part of the audit.

## References

- Read `references/report-contract.md` for the report layout, scoring rules, safe fields, and decision thresholds.
