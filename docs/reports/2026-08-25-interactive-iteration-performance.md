# Interactive Deep-agent iteration report — 2026-08-25

## Objective

Prevent broad code investigations from exhausting LangGraph recursion before a
final response, while making the resulting behavior auditable through the
existing LangSmith tracing and a minimal local performance record.

## What changed

| Control | Implementation | Audit signal |
| --- | --- | --- |
| Graph budget | Default 30 → 50; configuration rejects values above 60 | `recursionLimit` in JSONL and LangSmith metadata |
| Tool budget | Eight attempts per interactive Deep turn; tools are removed afterwards | `toolCalls`, `toolBudget`, `outcome` |
| Duplicate prevention | Identical earlier tool request returns a synthetic result | Tool names and trace timeline |
| Local record | `.agent/telemetry/interactive-turns.jsonl` | One JSONL line per finished/retried/recovered turn |
| LangSmith join | `agent_audit_id`, mode, model, and budgets supplied to stream config | Search the trace metadata by audit ID |

The record intentionally excludes prompts, response text, tool arguments,
credentials, provider payloads, and raw errors. Thread IDs are hashed.

## Measurement history

### Diagnostic baseline — Gemini 3.5 Flash

Five fresh, read-only technical prompts were executed with the same deep-agent
streaming path.

| Configuration | Completed | Limit failures | Observation |
| --- | ---: | ---: | --- |
| 30 recursion transitions | 0/5 | 5/5 | Tool exploration consumed all available transitions. |
| 50 recursion transitions, before hard tool budget | 1/5 | 4/5 | Increasing the limit alone did not stop equivalent RAG searches and repeated reads. |

Those runs established the failure mode. They are not a benchmark because the
repository index and model were not held constant across every exploratory run.

### Final cost-controlled validation — Gemini 3.1 Flash Lite

Only two real, read-only cases were run after the final middleware change.
`gemini-3.1-flash-lite` is the project catalog's cheapest cloud tier.

| Case | Request focus | Final outcome | Tools | Elapsed | Audit outcome |
| --- | --- | --- | ---: | ---: | --- |
| 1 | Resolve model for named Deep session | Final response emitted | 3 | 9.44 s | `completed` |
| 2 | Explain named-session Vertex 400 repair | Final response emitted | 2 | 7.39 s | `completed` |

Both cases stayed below the eight-tool ceiling. Therefore they verify real
streaming, inexpensive-model routing, LangSmith metadata injection, and local
audit persistence; they do **not** by themselves prove the live
forced-synthesis branch. That branch is covered by state-derived unit tests and
should be watched in LangSmith the next time a broad investigation naturally
reaches eight tools.

## How to audit the next session

1. Start Deep with the inexpensive tier: `npm run agent -- deep --model lite`.
2. Find the newest JSON line in `.agent/telemetry/interactive-turns.jsonl`.
3. Use its `auditId` value to find the LangSmith trace metadata field
   `agent_audit_id`.
4. Check `outcome`, `toolCalls`, `elapsedMs`, and the trace sequence. A healthy
   complex request either finishes below eight tools or returns a bounded final
   response identifying what remains unverified.

## Current limitations and follow-up metric

- The eight-tool limit is deliberately conservative to protect cost. If useful
  answers regularly terminate with missing evidence, increase only after
  examining trace repetition; do not raise the recursion limit above 60.
- A future ten-case comparison should use the same warmed index, model, and
  prompts, and report completion rate, median duration, tool-call distribution,
  limit hits, and recovery rate. It was not run here to respect the requested
  cost limit.
