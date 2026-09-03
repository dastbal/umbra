# ADR-026 — Vectors are numbers, and the database can count

| | |
|---|---|
| **Category** | RAG · Storage · Performance · Portability |
| **Author** | David Balladares (decision) · Claude (record) |
| **Date** | 2026-09-02 |
| **Status** | ✅ **Accepted** — implemented and measured on this repository |
| **Supersedes** | [ADR-025](./ADR-025-embeddings-are-chosen-not-assumed.md) §3, *one column per provider* |

---

## Context

David asked, from the first message of this work, for something **scalable and
improvable**. Two earlier records delivered capability — a read-only MCP server
([ADR-024](./ADR-024-umbra-as-a-read-only-mcp-server.md)) and interchangeable
embedding providers ([ADR-025](./ADR-025-embeddings-are-chosen-not-assumed.md))
— and neither touched the thing that actually does not scale.

Both records name it, as an accepted negative consequence, and neither fixes it:

> **Retrieval is a full scan.** `RetrieverService#query` runs
> `SELECT * FROM code_chunks` and computes `cosineSimilarity` in JS over every
> row.

Measured rather than assumed, on this repository's own index:

| | 258 chunks (this repo) | 50,000 chunks (~5,000 files) |
|---|---|---|
| bytes read and parsed per query | 4 MB | **772 MB** |
| time per query | ~300 ms cold, 44 ms warm | **~8.5 s warm** |

And half of that was the container, not the algorithm. One 768-dimension vector:

| | JSON text | Float32 BLOB |
|---|---|---|
| size | **16,208 bytes** | **3,072 bytes** |
| decoding 50 vectors, 200× | **1,130 ms** | **1 ms** |

A thousand-fold difference in decoding, for storing numbers as words. It is the
`"cuatro-siete-dos-ocho"` of data formats.

### What else the column layout could not express

ADR-025 §3 gave each provider its own column in `code_chunks`, on David's call,
and the reasoning was sound: it made the dangerous mistake — comparing vectors
from two unrelated spaces — unrepresentable rather than merely discouraged.

But the property it bought was narrower than it looked. A **model** upgrade
inside one provider reuses the same column. Moving from `text-embedding-004` to
a newer Vertex model would have mixed two unrelated vector spaces in
`vector_vertex_json`, which is the exact failure the columns existed to prevent,
arriving from inside a single provider. And a third provider needs an
`ALTER TABLE`, which is the opposite of *improvable*.

---

## Decision

Vectors move out of `code_chunks` into their own table, stored as binary, and
the distance is computed in SQL.

### 1. `chunk_vectors`, keyed by identity

```sql
CREATE TABLE IF NOT EXISTS chunk_vectors (
  chunk_id   TEXT    NOT NULL,     -- code_chunks.id
  provider   TEXT    NOT NULL,     -- 'vertex' | 'ollama'
  model      TEXT    NOT NULL,     -- the concrete embedding model
  dimensions INTEGER NOT NULL,     -- component count, for diagnosis
  vector     BLOB    NOT NULL,     -- little-endian float32 components
  PRIMARY KEY (chunk_id, provider, model),
  FOREIGN KEY(chunk_id) REFERENCES code_chunks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_chunk_vectors_identity
  ON chunk_vectors(provider, model);
```

**This generalises David's decision rather than reversing it.** The property he
wanted — no cell where two vector spaces can meet — is preserved by construction,
because the provider is part of the primary key. It now also covers the model,
which the columns could not, and a new provider becomes rows instead of schema.

### 2. Float32 BLOBs, and a view rather than a copy

`src/core/rag/vector-codec.ts` packs and unpacks. `decodeVector` returns a
`Float32Array` **view** over the stored bytes: nothing is allocated for the
components. `cosineSimilarity` was widened from `number[]` to
`ArrayLike<number>` so that view can be scored without being copied back into a
plain array — narrowing it again would silently reintroduce the cost this record
removes.

Float32 rather than Float64 is deliberate: models emit float32 internally, the
extra precision carries no information, and it would double the size. The loss
against the float64 values JSON happened to preserve is ~4e-7 on a cosine
distance, verified against `cosineSimilarity`.

The codec refuses rather than guesses. An empty vector throws, a buffer whose
length is not a whole number of float32 components throws, and a legacy JSON
value that is not a finite numeric array is skipped and counted — never coerced
into a row that would read as valid.

### 3. The distance is computed in SQLite

`sqlite-vec`'s `vec_distance_cosine`, with `ORDER BY distance LIMIT k`. Only the
rows that won are ever marshalled into JavaScript.

Loading the extension is **allowed to fail**. `sqlite-vec` ships a native binary
per platform as optional dependencies, so an unpublished platform or a
`better-sqlite3` compiled without extension support cannot load it. Retrieval
falls back to scoring the same BLOBs in JavaScript, which is still 5.3× fewer
bytes with no parsing. The failure is reported once with its reason, and
`provenance.rankedIn` says which path ran — a silent fallback would hide an
order-of-magnitude difference behind identical-looking results, which is the
shape of failure ADR-017 was written about.

### 4. Migration: automatic, additive, and reversible

`AgentDB.initSchema` imports the three legacy columns into `chunk_vectors` on
first open, with `INSERT OR IGNORE` against the primary key, so it is idempotent
and a second run writes nothing.

**The legacy columns are not cleared and not dropped.** They are the rollback,
and the surgeon's rule applies to storage as much as to code. An operator who
upgrades re-embeds nothing.

The migration is honest about what it cannot know. The column design recorded
the provider *by which column a vector sat in*, and recorded the model **not at
all**, so `LEGACY_COLUMN_IDENTITIES` asserts each column's default model. That
is true of every index this project has produced, because no model override was
ever configurable — but it is an assumption, not a fact, and it is itself part of
the argument for putting the model in the key.

### 5. Two properties carried forward unchanged

- **Check before embedding.** A one-row probe through
  `idx_chunk_vectors_identity` runs before any paid API call, so an unusable
  index still costs nothing to diagnose (ADR-025 §4).
- **A mismatch names the fix** — now with model granularity, which the columns
  could not distinguish at all.

A dimension change inside one provider is caught explicitly, because
`vec_distance_cosine` would otherwise fail with a message about byte lengths
that tells an operator nothing about what to do.

---

## Trade-offs

| Option | Pros | Cons | Decision |
|---|---|---|---|
| **A. Leave it** | No work. Imperceptible at 258 chunks | 772 MB and seconds per query on a real consumer project, and a third provider still needs an `ALTER TABLE` | ❌ |
| **B. BLOB in the existing columns** | Smallest diff; captures the 5.3× and the parse cost | Keeps the two limits that matter: a model upgrade still shares a column, and a provider is still schema | ❌ |
| **C. BLOB + normalized table, ranked in JS** | Both limits gone, zero new dependencies, no native binary | Still marshals every vector per query. Memory grows with the index | ❌ Kept as the **fallback path**, not as the design |
| **D. C, plus `vec_distance_cosine` in SQL** | Only `k` rows cross into JavaScript, so memory is flat in the index size | One native dependency, 304 KB, with a per-platform binary that can fail to load | ✅ **Chosen** |
| **E. `vec0` virtual tables (indexed KNN)** | Sublinear. The only option that changes the *order* of the scan | Fixed dimensions per table, a table per dimension count, and synchronisation to maintain. More machinery than two providers at 258 chunks justify | ❌ Deferred, with the measurement that would justify it |

**Option D is still a linear scan.** That is stated plainly because it would be
easy to imply otherwise: `sqlite-vec`'s scalar distance function does not index
anything. What changed is the constant and the marshalling, not the complexity.
Option E is what changes the complexity, and it is recorded in
`docs/deferred-work.md` rather than claimed here.

---

## DDD layer mapping

| Layer | Component | Impact |
|---|---|---|
| Domain | `src/core/rag/vector-codec.ts` | **New.** Encoding, decoding, and the refusals |
| Domain | `src/core/rag/math.ts` | `cosineSimilarity` widened to `ArrayLike<number>` |
| Domain | `src/core/rag/embeddings/embeddings.port.ts` | `EMBEDDING_VECTOR_COLUMNS` demoted to a migration input; `LEGACY_COLUMN_IDENTITIES` added |
| Application | `src/core/rag/retriever.ts` | Two ranking paths, the identity probe, provenance |
| Application | `src/core/rag/indexer.ts` | Writes a chunk row and a vector row; the backfill inserts rows |
| Infrastructure | `src/core/state/db.ts` | The table, the index, the migration |
| Infrastructure | `src/core/state/vector-extension.ts` | **New.** Loads `sqlite-vec`, reports failure once |

---

## Consequences

### Positive

- **5.3× fewer bytes and 14.7× faster** to read and decode the index.
- **Flat memory.** `k` rows cross into JavaScript instead of all of them.
- **A provider is rows.** Adding one needs no schema change.
- **A model upgrade is a distinct identity**, so it cannot mix spaces.
- **No reindex to upgrade**, and the legacy columns remain as rollback.
- **A portability bug was found on the way** — see *Verification Evidence*.

### Neutral

- `dimensions` is stored though both current models return 768. It costs 4 bytes
  per row and is the field that diagnoses a model that changed shape.
- The JavaScript ranking path is retained rather than deleted. It is the fallback
  and it is the reference the SQL path is tested against.

### Negative — accepted honestly

- **Still O(n).** See the Trade-offs table. Option E is the sublinear answer and
  is deferred.
- **One native dependency.** `sqlite-vec` is 304 KB with a per-platform binary.
  It can fail to load, and the fallback exists precisely because it can.
- **Rows are duplicated per identity.** A repository indexed with two providers
  holds two vector rows per chunk. That is the cost of coexistence, and it is
  disk rather than time.
- **Retrieval quality between providers is still unmeasured.** Unchanged from
  ADR-025: this record makes storage and ranking faster, and says nothing about
  whether `nomic-embed-text` finds the same code as `text-embedding-004`.

---

## Verification Evidence

Run on 2026-09-02 against the built output and this repository's real index.

**The extension gate, before any code was written.** Four checks, in order:

```
1. extension loaded        OK   sqlite-vec v0.1.9
2. vec_distance_cosine     OK   over two real vectors from code_chunks
3. agrees with our cosine  OK   js 0.23043312 vs sql 0.23043357, delta 4.44e-7
4. ORDER BY distance LIMIT OK   a vector is nearest to itself
```

Deliberately run first and alone: it is the only piece with platform risk, and
the plan's fallback depended on its answer.

**The migration lost nothing.**

```
⚙️  [DB] Migrated 516 vectors into chunk_vectors. The legacy columns were left untouched.

legacy columns:      vector_json 5 · vector_vertex_json 258 · vector_ollama_json 258
chunk_vectors:       ollama/nomic-embed-text 258 · vertex/text-embedding-004 258
chunks with BOTH:    258
vertex as JSON text: 3.99 MB → as BLOB 0.76 MB   (5.3× smaller)
```

The column counts are byte-for-byte what ADR-025's amendment 1 measured, so the
import added rows and touched nothing.

**Read and decode, before and after.**

```
JSON text      258 vectors   3.99 MB    44 ms
Float32 BLOB   258 vectors   0.76 MB     3 ms
→ 14.7× faster, 5.3× fewer bytes
```

**SQL against JavaScript ranking**, 30 iterations, same query vector:

```
SQL  (vec_distance_cosine + ORDER BY + LIMIT 4)   0.35 ms
JS   (read every BLOB, score, sort, slice 4)      1.11 ms
→ 3.1× faster; 4 rows crossing into JS instead of 258; same winning chunk
```

The honest framing: **the storage change was the large win, and the SQL change
is the one that keeps memory flat as the index grows.** Presenting 3.1× as the
headline would overstate it, and presenting the BLOB gain as this record's only
contribution would understate what happens at 50,000 chunks.

**A model nobody indexed is refused with the fix named**, and now at model
granularity:

```
The code index holds vectors from ollama, vertex, but this query uses
ollama/some-model-nobody-indexed. Vectors from different embedding models are
not comparable, so no similarity was computed. Re-index with UMBRA_EMBEDDINGS=…
```

**A portability bug, surfaced by moving off Node 10 module resolution.** With
`moduleResolution: "Node16"`, TypeScript reported exactly one error, and it was
real: `uuid@13` is ESM-only — its `exports` map has `node` and `default`
conditions and **no** `require`. So `require('uuid')` from this CommonJS build
works only on Node 22+, which permits requiring an ES module, while
`package.json` declares `engines: node >= 20`, where the same call throws. It
had gone unnoticed because this machine runs 22.21.1. Replaced with
`randomUUID` from `node:crypto`, built in since Node 14.17.

**Dependency count is unchanged at 19**: `sqlite-vec` added, `uuid` removed.

**The suite.** `737 passed, 5 skipped, 74 suites`, including new specs for the
codec (with the `byteOffset` trap: Node pools small Buffers inside one
`ArrayBuffer`, so a decoder that ignores the offset reads a neighbouring
vector's memory and fails silently), the extension loader, and the SQL/JS
agreement.

**End to end.** The round-1 handshake script, unmodified: 10 lines on stdout,
10 valid JSON-RPC, 0 stray bytes, and `ask_codebase` answering through the SQL
path.

### Not verified

- **No measurement on a repository large enough for this to matter.** Every
  figure above is 258 chunks plus arithmetic. The 50,000-chunk numbers are
  extrapolations, and they assume linearity that a real project's page-cache
  behaviour may not honour.
- **The JavaScript fallback has never run in anger**, because the extension
  loaded on the first attempt on this machine. It is unit-tested and has not
  been exercised by a real platform failure.
- No retrieval-quality comparison between providers.

---

## Related Files

- `src/core/rag/vector-codec.ts`, `vector-codec.spec.ts` — `encodeVector`, `decodeVector`, `encodeLegacyJsonVector`
- `src/core/state/vector-extension.ts`, `vector-extension.spec.ts` — `loadVectorExtension`
- `src/core/state/db.ts` — `chunk_vectors`, `migrateVectorsToBlobRows`, `AgentDB.vectorSearch`
- `src/core/rag/retriever.ts` — `rankInSql`, `rankInJavaScript`, `populatedProviders`
- `src/core/rag/indexer.ts` — `embedAndSaveBatches`, `backfillMissingVectors`
- `src/core/rag/math.ts` — `cosineSimilarity`
- `src/core/rag/embeddings/embeddings.port.ts` — `LEGACY_COLUMN_IDENTITIES`
- `src/core/rag/embeddings/vector-coexistence.spec.ts` — the regression suite, extended to the new table
- `src/core/tools/ast/chunker.ts` — `randomUUID` instead of `uuid`
- `tsconfig.json` — `module`/`moduleResolution` at `Node16`
- `docs/adr/ADR-025-embeddings-are-chosen-not-assumed.md` — the record this supersedes in part
- `docs/deferred-work.md` — `vec0` indexed KNN, and the measurement that would justify it
