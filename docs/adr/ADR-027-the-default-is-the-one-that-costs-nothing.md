# ADR-027 — The default is the one that costs nothing

| | |
|---|---|
| **Category** | RAG · Providers · Packaging · Adoption |
| **Author** | David Balladares (decision) · Claude (record) |
| **Date** | 2026-09-03 |
| **Status** | ✅ **Accepted** — implemented; amended 2026-09-03; ships in 2.2.0 |
| **Amends** | [ADR-025](./ADR-025-embeddings-are-chosen-not-assumed.md) §2, the last rung of the resolution ladder |

---

## Context

[ADR-025](./ADR-025-embeddings-are-chosen-not-assumed.md) made the embedding
provider selectable and kept `vertex` as the default, for a reason that was
correct at the time:

> The load-bearing rung is the last: **the default is still Vertex**, so an
> installation that changes nothing behaves exactly as it did.

That protected existing installations. It also means a **new** one arrives in
the worst possible state: `ask_codebase` is the headline capability of
`umbra mcp`, and out of the box it needs a Google Cloud project, Application
Default Credentials, and costs cents per query. ADR-024 recorded this as the
thing that "directly limits the adoption argument".

Two facts changed since:

1. **Local embeddings exist and are verified.** ADR-025's own *Not verified*
   list said `ask_codebase` had never been answered through Ollama. It has been
   now, repeatedly, including a run where Vertex credentials had expired
   (`invalid_grant / reauth`) and the tool kept working because Ollama needs
   none.
2. **A wrong provider can no longer be suffered silently.** ADR-026 keys every
   vector by `(chunk_id, provider, model)`, and querying an identity with no
   vectors raises a typed error naming the fix. That is what makes changing the
   default a *recoverable* decision rather than a dangerous one.

There is also a packaging reason. `umbra mcp` is meant to be installed by
strangers with `npx`, the way every other MCP server is distributed. A stranger
running `npx -y @dastbal/umbra mcp` should get four working tools, not three and
an instruction to create a Google Cloud project.

---

## Decision

**The default embedding provider is `ollama`.**

The ladder is otherwise unchanged: explicit argument → pinned → `UMBRA_EMBEDDINGS`
→ `.umbra/agent.config.json` → **`ollama`**.

Nothing about Vertex was removed, deprecated, or degraded. It is one line of
config, one environment variable, or one flag away, and its adapter is
untouched.

### The default lives in exactly one place

Implementing this exposed a defect introduced in ADR-025 and invisible until
now: **there were two defaults for one decision.** `ragSchema` in
`agent-config.ts` defaulted `embeddings`, *and* `resolveEmbeddings` had a final
rung. Because the schema always supplied a value, `loadAgentConfig` always
returned one, so the resolver's `config` rung always matched and its `default`
rung was **unreachable** — the ladder reported `source: 'config'` for a choice
nobody had made.

The schema field is now **optional**. Absent means *"not chosen"*, which is what
lets the resolver tell an operator's decision from nobody's, and the default
exists once. ADR-018's rule — one fact, one constant — applied to a default
instead of a directory name.

It was caught by a test asserting `selection.source`, not
`selection.port.identity.provider`. Asserting only the resolved value would have
passed throughout, because the value happened to be right for the wrong reason.

### `umbra init` no longer bakes in a provider

`ensureAgentConfig` writes `parseAgentConfig({})` to a new project. With the
field optional, that file no longer contains a provider, so a project scaffolded
today follows the package default and keeps following it when the default
improves. Previously it froze whatever the default was on the day it was
created.

---

## Trade-offs

| Option | Pros | Cons | Decision |
|---|---|---|---|
| **A. Keep `vertex`** | No existing install changes behaviour | Every new install has a missing capability and a Google Cloud prerequisite. The adoption objection ADR-024 named stays unanswered | ❌ |
| **B. Default to `ollama`** | A fresh install has free, offline semantic search. Matches how `npx`-distributed MCP servers are expected to work | An existing install with a Vertex-built index and no explicit config now queries the Ollama identity and gets a mismatch error until it re-indexes or sets one config line | ✅ **Chosen** |
| **C. Auto-detect: probe Ollama, fall back to Vertex** | Nobody ever sees a missing capability | Reintroduces exactly what ADR-025 was written against — the provider becomes *assumed* rather than *chosen*, and the same config behaves differently on two machines. Also adds a network probe to every startup | ❌ Rejected |

Option C is the tempting one and it is worth stating why it loses. ADR-025's
title is *"Embeddings are chosen, not assumed"*. A default that silently varies
by machine is an assumption wearing a convenience costume: two developers with
the same repository and the same config would build incompatible indexes and
have no way to see why.

### The migration cost of option B, stated plainly

An existing installation that (a) has a Vertex index, and (b) never wrote
`rag.embeddings` to its config, will get this on the next query:

```
The code index holds vectors from vertex, but this query uses
ollama/nomic-embed-text. Vectors from different embedding models are not
comparable, so no similarity was computed. Re-index with UMBRA_EMBEDDINGS=ollama,
or switch back to a provider the index already has.
```

Two fixes, both one step: add `{"rag": {"embeddings": "vertex"}}` to
`.umbra/agent.config.json`, or let it re-embed locally.

**This is why the version is 2.2.0 and not 2.1.5.** A default change that can
require operator action is not a patch, and hiding it in one would be the real
mistake.

---

## Consequences

### Positive

- **A first run works.** Four tools, no credentials, no cloud project, offline.
- **The adoption objection in ADR-024 is answered** — the one it recorded as
  directly limiting the case for publishing over MCP.
- **The default is in one place**, and the `default` rung of the ladder is
  reachable for the first time.
- **`umbra init` stops freezing a provider** into new projects.
- **Cost falls to zero** for the common case. Vertex was cents per query.

### Neutral

- Vertex is unchanged and fully supported. This record changes one default, not
  a capability.
- The resolution ladder's shape is untouched; only its last rung moved.

### Negative — accepted honestly

- **An existing install may need one action**, as above. Loud, diagnosable, and
  documented — but real.
- **Ollama must be installed and the model pulled.** When it is not, the probe
  withholds `ask_codebase` and says `ollama pull nomic-embed-text`. So the
  failure mode moves from "needs a Google Cloud project" to "needs a local
  daemon", which is cheaper but not nothing.
- **Retrieval quality between the two is still unmeasured.** This record changes
  which provider answers by default and makes **no claim** that Ollama retrieves
  as well as Vertex. The corpus for that comparison exists
  (`docs/benchmarks/embedding-retrieval-corpus.json`) and the audit has not run:
  its preflight blocks on unequal coverage. If the comparison later shows Ollama
  materially worse, this decision should be revisited — the whole point of
  ADR-025 and ADR-026 is that reversing it costs nothing.

---

## Verification Evidence

**The default resolves to Ollama in a project with no policy file.** Verified by
a spec that pins the runtime root at an empty temporary directory, which is the
only way to reach the rung at all:

```
defaults to ollama, so a first install has free search with no credentials
  → provider 'ollama', source 'default'
```

That test is the reason the two-defaults defect was found. Its first version
passed while asserting the provider alone, because the value was right for the
wrong reason; asserting `source` failed with `Expected "default", Received
"config"`.

**Vertex still wins when asked for**, by argument and by environment variable —
asserted in the same suite.

**A repository that does state a provider still gets it.** This repository's own
`.umbra/agent.config.json` sets `ollama`, and the resolver reports
`ollama/nomic-embed-text (from config)` — `config`, not `default`, which is now
a meaningful distinction.

**The suite.** `738 passed, 5 skipped, 74 suites`.

**Live, with no Google credentials at all.** During this session Vertex ADC
expired mid-work (`invalid_grant / reauth related error`). `umbra mcp` with
Ollama published four tools and `ask_codebase` answered, from a foreign working
directory, with pure stdout. That is the argument for this record, observed
rather than predicted.

### Not verified

- No retrieval-quality comparison. See the negative consequence above; it is the
  one thing that could justify reverting this.
- No measurement of how many existing installations rely on the implicit Vertex
  default. The package has one known operator, so the migration cost is
  believed small rather than known small.

---

## Amendment — 2026-09-03 · The initial paired audit did not establish a quality winner

The first independent comparison now exists. With equal, non-zero provider
coverage on this repository and no reindex, twenty approved queries were sent
once to each provider through fresh MCP processes. Both Vertex
`text-embedding-004` and Ollama `nomic-embed-text` reached **30% Hit@4**.

This closes the statement that no comparison had run. It does **not** establish
that the providers are equal: the corpus is small, their MRR differed, and a
retrieval result can be poor for chunking or ranking reasons rather than for
the embedding model. Most importantly, it does not retroactively make Ollama
the quality default. ADR-027 chose it for a credential-free first run; ADR-028
adds hybrid retrieval and an abstention policy before any quality promotion.

The next comparison is deliberately not run by this amendment. Its expanded
60-query corpus includes repository-derived query text, so a new Vertex run
needs explicit authorization for its exact count.

---

## Amendment — 2026-09-03 · Provider selection is reachable from the CLI

`/model → Embeddings` now records the operator's provider choice in the local
agent policy without changing the chat model. The menu reports availability but
does not index automatically: selecting Vertex makes a billable provider
explicit, it does not silently send repository code.

`umbra index --embeddings ollama|vertex` is the corresponding one-off command.
Its flag is passed directly to `IndexerService`, so the provider visible in the
command is the provider that writes the vectors. Existing provider/model rows
remain untouched by the other choice.

## Amendment — 2026-09-03 · Selecting a provider can start its index only with confirmation

The explicit command was safe but easy to miss after choosing a provider in
`/model`. The menu now asks whether to build the selected provider's index in
the same session. The default answer is **no**. For Vertex the confirmation
states that repository code is sent to Vertex AI and may incur charges; declining
keeps the provider selection and prints the one-off command. An unavailable
provider cannot be indexed from the menu.

This refines, rather than reverses, the earlier decision: provider selection
still never starts a paid index silently. The operator must make a visible
second choice before `IndexerService#indexProject` is called.

---

## Related Files

- `src/core/rag/embeddings/embeddings-resolver.ts` — the ladder and its last rung
- `src/core/config/agent-config.ts` — `ragSchema`, now without a default
- `src/core/rag/embeddings/embeddings.spec.ts` — `useEmptyProject`, and the `source` assertions
- `src/core/rag/embeddings/ollama-embeddings.adapter.ts` — `nomic-embed-text`
- `src/core/config/agent-config-writer.ts` — `setConfiguredEmbeddingsProvider`
- `src/presentation/cli/model-menu.ts` — `showEmbeddingsMenu`
- `src/presentation/cli/model-menu.spec.ts` — embedding-provider confirmation coverage
- `src/bin/cli.ts` — `index` command
- `docs/adr/ADR-025-embeddings-are-chosen-not-assumed.md` — the record this amends
- `docs/adr/ADR-026-vectors-are-numbers-and-the-database-can-count.md` — what makes the change recoverable
- `docs/benchmarks/embedding-retrieval-corpus.json` — the comparison that has not run
