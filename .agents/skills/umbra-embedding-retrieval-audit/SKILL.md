---
name: umbra-embedding-retrieval-audit
description: >
  Compares Umbra semantic retrieval with Vertex and Ollama embeddings on the same
  indexed repository and a fixed relevance corpus. Use in nestjs-ai-agent-lib when
  David says "auditá los embeddings", "compará Ollama y Vertex", "probá las
  búsquedas vectoriales", "testea el RAG", or "qué embedding busca mejor". Do
  NOT use for Deep-agent/model-quality audits; use umbra-runtime-audit instead.
allowed-tools: Read, Grep, Glob, Bash(node *), AskUserQuestion
---

# 🔎 Umbra Embedding Retrieval Audit

Compare retrieval quality, provenance, and latency without mixing vector spaces or modifying an index.

---

## ⚡ Trigger Phrases

- "auditá los embeddings"
- "compará Ollama y Vertex"
- "probá las búsquedas vectoriales"
- "testea el RAG"
- "qué embedding busca mejor"
- "compare Ollama and Vertex retrieval"
- "benchmark embedding search"

---

## 🔄 Step-by-Step Protocol

### Phase 0 — Preserve the boundary

1. State that this is a retrieval audit, not a model-chat audit.
2. Read `docs/adr/README.md`, then `ADR-025-embeddings-are-chosen-not-assumed.md` and any matching provider/RAG ADRs.
3. Run `node .agents/skills/umbra-embedding-retrieval-audit/scripts/preflight.mjs --root .`.
4. Stop if the report does not show equal non-zero coverage for `vertex`, `ollama`, and `both`.
5. Do not run the indexer, change `.umbra/agent.config.json`, alter vector columns, or delete workspace state.

### Phase 1 — Build an independent corpus

1. Copy `references/corpus.example.json` to a user-approved benchmark location outside this skill, normally `docs/benchmarks/embedding-retrieval-corpus.json`.
2. For each query, record one or more expected repository-relative paths before running retrieval.
3. Include exact-symbol, architecture, behavior, and negative queries. Include at least one non-matching query.
4. Do not derive expected paths from either provider's result; inspect source or accepted ADRs first.

### Phase 2 — Authorize the live comparison

1. Count the corpus queries and state that Vertex receives exactly that many query embeddings and repository-derived query text.
2. Obtain explicit authorization for the exact Vertex query count, provider list, root, and `--no-index` scope.
3. Treat Ollama availability as local-runtime evidence, not proof that the intended embedding model is installed.
4. If authorization is absent, report the preflight and corpus only. Do not start either benchmark server.

### Phase 3 — Run paired MCP probes

1. Run the benchmark in fresh MCP processes with `--providers vertex,ollama --no-index`.
2. Use `scripts/run-benchmark.mjs` with the approved corpus. It launches `node dist/bin/cli.js mcp --root <root> --embeddings <provider> --no-index` and calls `ask_codebase` over JSON-RPC.
3. Verify each result proves the selected active provider. The header names the most recent index stamp; when it differs, it must explicitly say `queried with <active-provider>/<model> — provider mismatch`.
4. Do not compare raw cosine scores across providers. Compare each provider's ranking against the corpus oracle only.
5. Do not retry a failed Vertex query automatically; it is another billable external request.

### Phase 4 — Report and stop

1. Read `references/report-contract.md` before writing the result.
2. Report coverage, availability, provenance correctness, `Hit@4`, MRR, median/p95 latency, errors, and the count of calls made.
3. Recommend a provider only if it passes every hard gate and improves retrieval quality on the fixed corpus; use latency/cost only as tie-breakers.
4. Label all conclusions as source-verified, local-runtime-verified, live-Vertex-verified, or not verified.

---

## 📐 Output Standards

The audit report must name the corpus revision, repository root, provider/model identity, index coverage, exact authorized/executed Vertex call count, and all hard-gate failures.

How to know this worked: the preflight reports matching non-zero provider coverage, both fresh MCP processes prove their selected active provider (directly or through the mismatch warning), and the report derives metrics from the same corpus for both providers.

Read `references/corpus.example.json` only when creating a corpus. Read `references/report-contract.md` only when preparing the final report.

---

## ⚠️ Guardrails & Anti-Patterns

| Never do | Do instead |
| --- | --- |
| Compare Vertex vectors directly with Ollama vectors because both have the same dimensions | Query each provider's own column and compare rankings to the same independent oracle |
| Warm, reindex, or switch configuration during a quality comparison | Require equal coverage first and pass `--no-index` to both fresh MCP processes |
| Send queries to Vertex because the user merely asked for a plan or a skill | Obtain authorization for the exact query count and corpus scope |
| Declare a winner from one anecdotal retrieval | Use the fixed corpus and report failures, coverage, and metrics alongside latency |
| Treat `--model` as an embeddings switch | Use `--embeddings vertex|ollama`; chat-model selection is a separate Deep/Orchestrate concern |
