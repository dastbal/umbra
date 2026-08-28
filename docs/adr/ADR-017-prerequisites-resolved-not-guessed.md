# ADR-017: Prerequisites are resolved, not guessed

## Status

Accepted

## Date

2026-08-28

## Deciders

David Balladares, with Claude

## Context

The first run of the published package inside a real consumer project —
`londonuw-epay-payments` — failed in three independent ways in one session.
None of them appeared in this repository, because this repository's `.env`
happens to declare what the failures depend on.

### Failure 1 — the project was guessed, then reported as undetectable

Indexing 86 files produced fourteen identical `Unable to detect a Project Id`
errors, then the first message failed the same way. `umbra auth login --project
blue-label` succeeded — ADC written, quota project attached — and **changed
nothing**.

The cause: only Claude's route resolved the project. `getEmbeddingsModel` and
all three `VertexChatAdapter` construction sites passed none, leaving detection
to `google-auth-library`. Its detection reads `GCLOUD_PROJECT`,
`GOOGLE_CLOUD_PROJECT`, gcloud's own config, and the GCE metadata server. On
this machine the gcloud CLI is broken (no Python), and — verified against the
real file — an `authorized_user` ADC file carries `quota_project_id` and **no**
`project_id`. The project the operator had just authorized was sitting in the
file, and nothing read it.

So the provider Umbra hardened last (Claude, ADR-015) was the only one that
worked, and the default provider was the one that guessed.

### Failure 2 — Ollama's tool exclusions were silently discarded

Asked to explain the project, Ollama called `ls`, got an empty directory in 2ms,
and reported that there were no files. Claude, on the same repository, called
`list_files` and read it correctly.

`ls` is deepagents' built-in filesystem tool, backed by an in-memory
`StateBackend`, not the disk. Umbra registers an `ollama` harness profile that
excludes it. That profile never applied.

Verified against `deepagents@1.10.x` source and by construction:

| Adapter | `getName()` | provider hint | identifier hint | Profile resolved |
|---|---|---|---|---|
| `OllamaChatAdapter` | `ChatOllama` | **undefined** | **undefined** | **empty** |
| `VertexChatAdapter` | `ChatGoogleGenerativeAI` | `google` | `gemini-2.5-flash-lite` | `google:…` ✓ |
| `ChatAnthropic` | `ChatAnthropic` | `anthropic` | `claude-sonnet-5` | `anthropic:…` ✓ |

Umbra passes prebuilt model instances, so deepagents resolves the profile from
the instance. The provider hint comes from a three-entry map keyed on
`getName()` — `ChatAnthropic`, `ChatOpenAI`, `ChatGoogleGenerativeAI` — and the
identifier from `model_name ?? modelName`, neither of which `ChatOllama`
defines. Both hints missing means the empty profile, which means `ls`,
`read_file`, `write_file`, `edit_file`, `grep` and `glob` all stayed live.

**The model never hallucinated.** A tool told it the repository was empty and it
reported that faithfully.

A comment in `deep-agent-factory.ts` asserted that resolution falls back to the
`ollama` provider key for a three-part spec. It does not: `getHarnessProfile`
returns early for any spec with more than two colon-separated parts, before the
provider key is consulted. That comment was an assumption written as fact.

### Failure 3 — a partial index reported success

After fourteen failed batches the run printed `💾 Vectors Saved.` and
`✅ Indexing Complete.` Worse than the visible crash: the operator reads a green
line and trusts an index that is missing content.

### Also — `umbra init` left its own state in the consumer's git

Roughly two dozen untracked files: session databases, write-ahead logs, the RAG
index, `.agent/`. All regenerate on their own, none mean anything on another
machine, and all were one `git add -A` away from being committed.

## Decision

### The project is resolved from what the login actually wrote

`LLMProvider.resolveProjectId()` prefers `GOOGLE_CLOUD_PROJECT` and otherwise
reads `quota_project_id` from the local ADC file — exactly the field
`umbra auth login --project X` stores and Google's own detection ignores. Only
that one field is read; no credential material is loaded or logged.

The resolved value is then **published into `GOOGLE_CLOUD_PROJECT`** by
`ensureVertexCredentials`, which every Vertex path already calls. That variable
is the only lever reaching every Google client, including ones Umbra does not
construct. An explicitly configured project is never overwritten.

Per-client injection was tried first and was not enough:
`@langchain/google-vertexai` has no `project` option — the project belongs in
`authOptions.projectId` — and the raw error survived until the environment
variable was set. The unit tests were green while the real thing still failed,
which is why this record claims live verification rather than coverage.

### Ollama declares a hint that deepagents can actually resolve

`OllamaChatAdapter` exposes `modelName` as `ollama:<tag>`, with the tag's colon
replaced by a dash. Two constraints, both from deepagents' source: the hint must
contain a colon for the identifier branch to be taken at all, and must have
exactly two colon-separated parts or it is rejected before the provider key is
read. `ollama:gemma4-e2b` satisfies both and lands on the registered `ollama`
profile; `ollama:gemma4:e2b` would resolve to nothing.

The hint is for lookup only — `model` still carries `gemma4:e2b`, which is what
the Ollama API needs.

### A partial index says so

`embedAndSaveBatches` returns what succeeded and what failed. Failures are
counted and summarized once — distinct messages with a batch count, first line
only — instead of one library stack trace per batch. Completion is reported as
`⚠️ Indexing finished with gaps` whenever any batch failed.

### `umbra init` ignores its own state, and only its own state

`ensureAgentStateIgnored` appends `.agent/`, the three
`deep_agent_history.db*` files and `interactive-turns.jsonl` to the consumer's
`.gitignore`, creating the file when absent, appending only what is missing, and
rewriting nothing.

`skills/` and `docs/adr/` are deliberately **not** ignored. ADR-012 scaffolds
them into the consumer project precisely so they are versioned there; ignoring
them would quietly undo an accepted decision.

### Amendment: an ignore rule cannot stop a file git already tracks

On 2026-08-28, David pointed out what the decision above quietly assumed:
*"pero ignorarlo en github después se sube"*. He is right, and the gap is real.

`.gitignore` governs **untracked** files only. A project that committed its
workspace under an older Umbra keeps pushing it on every commit, and the rules
added here are silently powerless — session databases and the RAG index keep
travelling to the remote while the operator believes they are excluded.

`findTrackedAgentState` runs `git ls-files` and reports any tracked path matching
the agent-state rules. `umbra init` prints the count, up to five paths, and the
exact `git rm --cached -r` command.

It **reports and does not act**. Untracking rewrites the index, and once
committed it deletes the file for every teammate who pulls. That is the
operator's call, not an installer's. A project that is not a git repository, or a
machine without git, yields nothing rather than an error.

Verified end to end: a project that had committed `.agent/index.meta.json` and
`deep_agent_history.db` was warned by `umbra init`, with both paths named and the
untrack command printed, while the files stayed tracked until the operator acts.

The guides and decision records are never reported — they are meant to be
tracked, which is the same boundary the ignore list respects.

## Alternatives considered

### Have `umbra deep` offer to run the login when a prerequisite is missing

This is what David asked for, and it is not what shipped. Once the project is
read from the file the login already wrote, the prerequisite that prompted the
request is satisfied without a prompt — the login had already been run. Offering
to re-run it would have papered over the actual defect. The general shape (a
preflight that offers to fix each missing prerequisite) is recorded in
`docs/deferred-work.md` rather than built, because it is worth doing across all
prerequisites and not just this one.

### Read gcloud's own configuration for the project

Rejected. It is exactly the source that was unreadable on this machine, and
depending on a second CLI's on-disk layout adds a failure mode Umbra cannot fix.

### Give `OllamaChatAdapter` a `getName()` that deepagents recognizes

Rejected. Reporting `ChatGoogleGenerativeAI` from an Ollama adapter would make
the profile resolve by lying about the class, and would reroute every other
`getName()`-based decision in the library — including Anthropic prompt caching.

### Ignore everything `umbra init` writes

Rejected. It would silence the noise by also un-versioning the guides and
decision records that ADR-012 deliberately puts under version control.

### Retry the failed embedding batches automatically

Rejected for now. Every failure in the observed run had the same cause, so a
retry would have multiplied a certain failure fourteen times. Reindexing after
fixing the cause is recorded in `docs/deferred-work.md` as the transactional
shape this deserves.

## Consequences

- After `umbra auth login --project X`, a consumer project needs no Google
  configuration of its own. Verified from a directory with no `.env` at all.
- Umbra now sets `GOOGLE_CLOUD_PROJECT` in its own process when it was unset.
  That is a deliberate environment mutation, matching what the credentials path
  already does, and it never overrides an explicit value.
- Ollama receives Umbra's guarded filesystem tools instead of deepagents'
  in-memory ones, so a local model reads the real repository.
- Umbra depends on two `deepagents` internals — the `getName()` provider map and
  the two-part spec limit. A version bump can break the Ollama hint silently.
  `ollama-harness-hint.spec.ts` guards the shape Umbra controls; it cannot guard
  the library's behaviour, which was verified out-of-band.
- An incomplete index is now visible as incomplete.
- `umbra init` writes to the consumer's `.gitignore`. It only appends, but it is
  a write to a file Umbra does not own.

## Validation

- The full Jest suite passes: 54 suites, 456 tests, with the gated live suite
  and five unrelated tests skipped. One `line-editor` test fails intermittently
  in the parallel full run and passes 3/3 in isolation; it fails identically on
  clean `HEAD` with these changes stashed, so it is pre-existing and unrelated.
- TypeScript type-check and the build pass.
- **From a directory with no `.env` and no `GOOGLE_CLOUD_PROJECT`**, through the
  compiled `dist/`: the project resolved to the ADC value, a live Gemini chat
  returned, and live embeddings returned 768 dimensions. This is the exact
  condition that produced fourteen errors and a dead session.
- The Ollama hint resolves the registered `ollama` profile — with `ls` among the
  exclusions — for `gemma4`, `gemma4:e2b`, `gemma4:26b` and `qwen3.6:4b`,
  checked against deepagents' exported `getHarnessProfile`.
- The three-part spec rejection and the empty-profile resolution for
  `ChatOllama` were both reproduced directly against the installed library.

## Related files

- `src/core/llm/provider.ts` — `resolveProjectId`, `publishProjectToEnvironment`
- `src/core/llm/ollama-adapter.ts` — the `modelName` harness hint
- `src/core/rag/indexer.ts` — failure counting and honest completion
- `src/core/config/workspace-scaffold.ts` — `ensureAgentStateIgnored`
- `src/bin/cli.ts` — `umbra init` reporting
