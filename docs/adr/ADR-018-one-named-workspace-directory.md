# ADR-018: One named workspace directory

## Status

Accepted

## Date

2026-08-28

## Deciders

David Balladares, with Claude

## Context

ADR-017 made `umbra init` add the agent's local state to the consumer's
`.gitignore`. David's next question was better than the fix: *"¿no debería
guardarse con otro nombre, porque chocará con el `.agent` si usan otro agent?"*

Two separate problems came out of checking it.

### The name is generic, and this machine runs four agents

`.agent/` says nothing about which agent owns it. The ecosystem convention is
vendor-named — `.claude/`, `.codex/`, `.gemini/`, `.cursor/` — and what tools
actually share is the `AGENTS.md` *file*, not an `.agent/` *directory*. No major
tool is known to claim `.agent/` today, but that is an absence of evidence, not
evidence of absence.

The concrete case is not hypothetical: this machine runs Claude Code, Codex,
Antigravity and Gemini CLI alongside Umbra. In a repository touched by all of
them, "whose `.agent/` is this?" has no answer.

### The name was written in thirteen places

More important than the name. Every consumer built its own path:

`deep-agent-factory.ts` (×3), `factory.ts`, `graph-factory.ts`,
`safe-backend.ts`, `agent-config.ts` (×2), `metrics.ts`, `db.ts`,
`file-tools.ts`, `adr-index.ts`, `turn-audit.ts`, `provider-diagnostics.ts` (×2).

This is the fourth appearance of the shape this repository keeps meeting: **one
fact assembled in many places and verified in one.** It is recorded for the tool
registry in `docs/deferred-work.md`, and twice in
[ADR-017](./ADR-017-prerequisites-resolved-not-guessed.md) — the harness profile
and the project id.

It had already produced a false statement. `agent-config.ts` claimed the policy
file *"lives under `.agent/`, **which is ignored**"*. That was true only in this
repository, which has `.agent/` in its own `.gitignore`; in a consumer project it
was never true until ADR-017. Another assumption written as fact.

## Decision

### One constant, and it is the fix

`src/core/config/agent-directory.ts` owns the name. `agentPath(rootDir, ...)`
builds every path below it, and all thirteen call sites use it. **Zero hardcoded
occurrences remain in `src/`**, verified by grep.

This half would have been worth doing even if the name had stayed. Renaming was
the occasion, not the reason.

### The directory is `.umbra/`

It matches the package (`@dastbal/umbra`) and the binary (`umbra`), and admits
no ambiguity about ownership on a machine with several agents.

### A rename without a move is data loss

`migrateLegacyAgentDirectory` moves an existing `.agent/` to `.umbra/` before
anything reads or writes the workspace — in the deep/orchestrator bootstrap and
in `umbra init`, the two entry points a project goes through.

The RAG index, the session history, the backups and the local policy all live
there. Skipping the migration would have presented as "reindexing", which is the
polite name for discarding state the operator did not agree to lose.

Three cases, deliberately distinguished:

- **legacy only** → moved, and the operator is told.
- **neither** → nothing happens; the directory is created as before.
- **both** → nothing is touched, and the operator is told which one is in use.
  Two workspaces mean two session histories; merging or overwriting could
  discard work, so that choice stays with the operator.

A failed move is reported, never thrown. Umbra recreates what is missing;
refusing to start because an old directory could not be renamed would be worse
than reindexing.

### Both names stay ignored

`AGENT_LOCAL_STATE_IGNORES` lists `.umbra/` **and** `.agent/`. A project that has
not been started since this change still holds the legacy directory, and it must
not become committable during that window.

### The older records are amended in one place, not eight

Eight accepted ADRs reference `.agent/`. They are **not** rewritten: the
surgeon's rule applies to decision records, and those references are accurate
statements about what was true when each was written. This record supersedes the
directory name for all of them, and the ADR index carries a single note saying
so, rather than eight edits that would each need their own amendment.

`README.md` **is** updated — it is documentation of current behaviour, not a
record of a past decision.

## Alternatives considered

### Keep `.agent/`

Rejected on David's reasoning, which holds: the name is generic, the collision
cannot be ruled out, and on a machine running four agents it is ambiguous to a
human reader regardless of whether any tool ever claims it.

### Rename with a find-and-replace over the thirteen sites

Rejected. It leaves thirteen independent truths and the next rename repeats the
work — and, worse, a partial replacement would split the workspace in two
silently, with some components reading the old directory and some the new.

### Rename without a migration

Considered and explicitly waived by David — *"no importa, aún no está live"* —
and implemented anyway. Only `2.0.0` is published, so the npm argument is weak,
but the local argument is not: `londonuw-epay-payments` holds a populated
`.agent/` right now, and the migration is a few lines against a guaranteed
reindex plus lost session history.

### Make the directory name configurable

Rejected for now. It multiplies the number of possible workspace locations to
support and debug, and nobody has asked for it. The constant makes it a small
change if that ever becomes a real need.

## Consequences

- One place names the workspace. A future rename is a one-line change.
- An existing project keeps its index and history across the rename, and is
  told that it moved.
- Two directory names must stay ignored until projects have all been started
  once. The legacy rule can be dropped later, and that is a judgment call with
  no forcing function to remind anyone — the risk of it lingering forever is
  accepted, since an extra ignore line is harmless.
- Eight accepted ADRs now contain a path that no longer exists. The index note
  is the only thing stopping that from misleading a reader, which is weaker than
  amending each record and was chosen deliberately over eight edits.
- `agent-config.ts`'s claim that the directory "is ignored" is finally true in a
  consumer project, as of ADR-017.

## Validation

- The full Jest suite passes: 54 suites, 463 tests, with the gated live suite
  and five unrelated tests skipped. TypeScript type-check and the build pass.
- The rename was caught by five existing specs that asserted the old path.
  They now import `AGENT_DIR_NAME` instead of hardcoding a name, so the same
  drift cannot recur.
- `grep` confirms no hardcoded `'.agent'` or `".agent"` remains in `src/`
  outside `agent-directory.ts` itself.
- **End to end through the compiled `dist/`**: a project seeded with
  `.agent/index.meta.json` and `.agent/telemetry/` was migrated by `umbra init`,
  which reported `Workspace moved: .agent/ → .umbra/`, preserved the seeded file
  under `.umbra/`, and wrote a `.gitignore` covering both names.
- The both-exist and no-legacy cases, and idempotence across repeated calls, are
  covered by `agent-directory.spec.ts`.

## Related files

- `src/core/config/agent-directory.ts` — the constant, `agentPath`, the migration
- `src/core/config/workspace-scaffold.ts` — both names in the ignore list
- `src/core/agent/deep-agent-factory.ts` — migration at bootstrap
- `src/bin/cli.ts` — migration in `umbra init`
