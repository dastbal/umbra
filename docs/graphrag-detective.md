# GraphRAG Detective

## Purpose

GraphRAG Detective is Umbra's local, deterministic retrieval laboratory. It
answers one practical question: when does a code question benefit from following
repository relationships after hybrid retrieval, and when does that extra work
only add noise?

This is a living design document, not an ADR. The mechanism is deliberately
measurable and reversible while its retrieval policy evolves.

## Model

Umbra keeps code chunks, lexical search, vectors, file dependencies, and NestJS
wiring in its existing SQLite workspace. SQLite is the graph projection:

- `dependency_graph` records typed file-to-file relationships such as imports
  and re-exports.
- `nest_bindings` and `nest_injections` record NestJS relationships that cannot
  honestly be represented as file paths alone.
- `code_chunks` remains the source evidence store. A graph path is a route to
  evidence, never evidence by itself.

No graph database or embedded chat model is required. Embeddings discover the
semantic seeds, SQLite follows bounded typed relationships, and the calling
assistant reasons over the returned source evidence.

## Retrieval policies

The stable policies are versioned code-defined profiles:

| Policy | Retrieval plan |
| --- | --- |
| `hybrid-v1` | Hybrid semantic and lexical retrieval only. |
| `dependency-1-v1` | One outgoing dependency hop from grounded seeds. |
| `dependency-2-v1` | Bounded bidirectional dependency traversal. |
| `nest-v1` | NestJS provider, injection, and module traversal. |
| `combined-v1` | Dependency and NestJS traversal when both are healthy. |
| `balanced-v1` | Production default; deterministically chooses the most useful eligible plan. |

The planner is not an LLM. It applies explicit eligibility, readiness, and
budget rules. The CLI agent may decide what to do with the resulting evidence;
the MCP server never samples or calls a chat provider.

## Budgets and stopping

Every request begins with one hybrid lookup. Detective plans share that result;
they do not embed the same question repeatedly.

| Mode | Seeds | Depth | Nodes | Relations | Chunks | Estimated context |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Standard | 4 | 2 | 24 | 48 | 8 | 8,000 tokens |
| Detective deep | 4 | 3 | 48 | 96 | 12 | 14,000 tokens |

Traversal stops at every hard ceiling and also stops when a hop contributes no
new indexed file. More graph nodes are not progress unless they add novel,
inspectable source evidence. Each run retains a source-free receipt per hop:
frontier size, inspected relations, novel evidence, discarded branches, and an
explicit stop reason. A graph that is unavailable, stale, or empty in a way
Umbra cannot prove is ready is skipped; it never becomes a claim that the
repository has no relationship.

## Operating modes

`/detective <question>` evaluates every eligible standard plan and prints the
shared seeds, branches, selected paths, discarded paths, depth, budgets,
timings, and a direct comparison. `/detective deep <question>` uses the deeper
bounded budget for a local experiment.

Each Detective run writes a local trace below `.umbra/detective/`. The trace
contains the question, index fingerprint, plan decisions, paths, relationship
types and counts, per-hop receipts, scores, timings, token estimates, and
recommendation. It does not contain code snippets, tool payloads, model
responses, or credentials.

`/detective replay <trace-id>` reruns the question and compares it only when
the index fingerprint matches. A provider, model, corpus, or indexed-file hash
change starts a new experiment instead of producing a misleading delta.

`/detective promote <policy>` is intentionally manual. It displays the latest
compatible Detective evidence and atomically saves the selected code-defined
policy in `.umbra/agent.config.json`. Umbra never promotes a policy by itself
and never writes learned weights into production configuration.

## MCP and production

`ask_codebase(query, context?)` remains backward compatible. Production uses
the approved policy and returns source evidence plus a compact deterministic
strategy and next recommendation. It does not write Detective traces or print
the experiment ledger.

`investigate_graphrag(query, mode?)` is the opt-in MCP counterpart for an
external assistant that needs to compare plans before deciding what to inspect.
It returns the same source-free plan receipt — paths, typed routes, budgets,
timing, stop reasons, and recommendations — but deliberately does **not**
persist the question or produce a replayable trace. `/detective` remains the
local CLI laboratory and the only route that writes a private trace or permits
manual promotion.

The recommendation may tell the MCP client that the evidence is sufficient, or
name `query_dependency_graph` or `query_nest_graph` as the most useful next
read-only action. The external assistant decides whether to take that action
and is responsible for the bounded reasoning loop.

## Measurement

Policy reports use the existing retrieval vocabulary: Hit@1, MRR, grounded
evidence rate, correct and false abstentions, median and p95 latency, nodes,
relations, selected context, and marginal evidence. A free-form Detective
question has no expected answer, so it reports structural and latency facts but
marks quality scores unavailable. When its exact question belongs to the
project's versioned retrieval corpus, Detective records the one-case Hit@1,
MRR, and abstention facts instead of guessing. Aggregate median and p95 claims
remain the benchmark runner's job. Comparisons must name the same corpus and
index fingerprint. A human reads those facts before promotion; the metrics
inform the decision but do not automate it.

## Observed local audit — 2026-09-17

One unlabelled Deep Detective run completed against a healthy local index. The
four hybrid seeds were plausible MCP/search entry points. Dependency expansion
admitted additional import neighbours, while the NestJS projection contributed
no matching relationship for those seeds. `dependency-2` and `combined` reached
the same relation ceiling, so this run does not support a claim that the
combined plan improved evidence.

The run also exposed a contract discrepancy: the profile named
`dependency-1-v1` reached depth two, although the policy table describes one
outgoing hop. The trace did its job by making the discrepancy visible. It was
corrected on 2026-09-17: `GraphRagService#budgetForPlan` now caps this plan at
one hop regardless of the wider standard or deep mode budget. Earlier traces
remain historical observations and must not be compared as if they had used the
corrected plan.

The displayed 1–34 ms values measure deterministic graph planning after the
shared hybrid seed retrieval; they do not include the embedding lookup. The
question had no versioned expected paths, so Hit@1, MRR, and abstention quality
were correctly reported as unavailable rather than inferred from a readable
answer.
