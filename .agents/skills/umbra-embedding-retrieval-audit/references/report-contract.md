# Embedding Retrieval Audit Report

1. **Verdict** — pass, pass with advisories, fail, or blocked.
2. **Scope** — corpus version, root, repository state, providers/models, and authorized/executed Vertex calls.
3. **Index preflight** — total chunks plus Vertex, Ollama, and overlap counts.
4. **Scorecard** — one row per provider: availability, provenance, queries completed, Hit@4, MRR, median/p95 latency, errors.
5. **Hard-gate failures** — unequal coverage, unavailable provider, wrong provenance, index mutation, or an unapproved Vertex call.
6. **Recommendation** — quality first; latency and cost only decide a quality tie.
7. **Limits** — corpus size, untested queries, and whether source files changed after the corpus was approved.

Never include query text, returned code, raw vectors, credentials, or provider payloads in a shareable report.
