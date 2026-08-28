# Umbra Runtime Audit Report Contract

Use this reference only after evidence collection, while composing an audit report or comparing models.

## Report layout

1. **Operational verdict** — pass, pass with advisories, fail, or blocked; say why in one sentence.
2. **Scope and authorization** — repository state, audit mode, models, live calls authorized/executed, and whether any turn was interrupted.
3. **Scorecard** — one row per model/probe.
4. **Verified findings** — severity, symptom, mechanism, evidence level, and `path#symbol` or audit id.
5. **Performance breakdown** — startup/indexing separated from turn duration when measurable; tool time versus total time; tokens and displayed/estimated cost.
6. **Recommendation** — default, escalation, and unsupported/not-ready choices, tied to a workload.
7. **Limits and next evidence** — what did not run and the smallest next probe. Stop there.

## Scorecard

| Dimension | Score | Evidence rule |
|---|---:|---|
| Correctness | 0–3 | 0 wrong/no answer; 1 partial; 2 correct with gaps; 3 correct and grounded |
| Instruction obedience | 0–3 | Include scope, read-only, tool count, and output format |
| Tool-cycle completion | 0–2 | 0 no cycle/failure; 1 first leg only; 2 final answer after required tool result |
| Evidence discipline | 0–2 | Correct files/symbols and fact/inference separation |
| Runtime reliability | 0–2 | Completion, no unexplained stall, and documented budget behavior |

Score quality first: `correctness + obedience + tool-cycle + evidence` (10). Runtime reliability is a
separate operational signal. Time and cost are tie-breakers among models that clear the quality bar.

## Model decision rule

Recommend a model as **default** only when it:

- completes every required probe at or above 8/10 quality;
- has no unapproved tool, write, or scope violation in the tested corpus;
- completes at least one real tool-result round trip when the default workflow needs tools; and
- has a practical latency/cost profile for the workload.

Recommend an **escalation** model when it materially improves a hard task but has insufficient evidence
or a less practical profile for routine work. Mark a model **not ready** when routing, authorization,
or a complete tool cycle remains unverified. Do not call a model worse merely because it was not tested.

## Safe performance fields

Safe to report: model id, reasoning setting, mode, number of starts/completions/errors, elapsed time,
tool count and names, tool duration aggregates, token totals, displayed/estimated USD, audit id hash,
and aggregate percentiles.

Never report: prompts, responses, source snippets returned by the provider, tool arguments, absolute
paths from private telemetry, credentials, raw provider errors, request/response payloads, or trace URLs.

## Severity guide

| Severity | Meaning |
|---|---|
| P0 | Unsafe write/security boundary crossed, or cost can run without a usable stop |
| P1 | Incorrect result, unapproved tools, repeated tool cycle, or routine turn fails to complete |
| P2 | Material latency/cost inefficiency, incomplete observability, or weak recovery evidence |
| P3 | UX/measurement advisory or unverified optimization |

## Wording rules

- Say **"observed"** for a specific run.
- Say **"telemetry shows"** for aggregates.
- Say **"source indicates"** for static behavior.
- Say **"not verified live"** for any provider path that was not run in this audit.
- Never transform an inference into a vulnerability or a provider defect.
