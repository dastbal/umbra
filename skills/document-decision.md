---
name: document-decision
description: Record a durable architectural decision as an ADR in docs/adr/ of the project currently being worked on — honest, verifiable, and cheap for a future agent to navigate
triggers: [ADR, decision record, document this decision, why did we, architectural decision, documentalo, documenta esto, supersede, deprecated decision, migration decision]
---

# Skill: Document a Decision (ADR)

> This skill writes into **the project you are working on**, never into the
> agent's own repository. `docs/adr/` here means the target project's `docs/adr/`.
> The ADR records **why** a decision was made — the one thing source code can
> never state on its own.

## Step 0 — Decide whether this deserves an ADR at all

Write an ADR only when the decision is **durable and expensive to reverse**:

| Write an ADR | Do NOT write an ADR |
|---|---|
| A layer boundary or dependency direction changed | A routine refactor or rename |
| A persistence, transaction, or migration strategy was chosen | A local variable extraction |
| An authentication, authorization, or safety boundary moved | Small UI polish, copy, spacing |
| A public contract changed (DTO, interface, endpoint shape) | A bug fix with one obvious correct answer |
| A third-party provider or library was adopted or dropped | Anything reversible in one commit |
| A trade-off was accepted knowingly (cost, latency, consistency) | Work you have not actually implemented yet |

If it is not on the left column, **do not write one**. A folder of trivial ADRs
is worse than an empty folder: it buries the three records that mattered.
When genuinely unsure, use `ask_human` — do not guess.

## Step 1 — Read before writing

```
list_adrs()                                  ← index only, never all bodies
safe_read_file("docs/adr/<the one match>")   ← only the record your decision touches
```

Purpose: find the existing ADR your decision **refines or reverses**. Writing a
record that silently contradicts an accepted one is the most expensive mistake
in this skill.

- **Refinement** of the same decision → amend that ADR in place (see Step 4).
- **Reversal or replacement** → new ADR, and set the old one's status to
  `Superseded by ADR-XXX`.

If `docs/adr/` does not exist, create it with a `README.md` index (Step 5).

## Step 2 — Pick the number

Highest existing `ADR-NNN` plus one, zero-padded to three digits.
File name: `docs/adr/ADR-013-short-kebab-title.md`.
**Never renumber an existing ADR** and never overwrite one with a different decision.

## Step 3 — Write the record

Required sections, in this order:

```markdown
# ADR-013: <imperative, specific title>

**Category:** <e.g. persistence, authorization, module boundary>
**Author:** <who actually decided and implemented it>
**Date:** <YYYY-MM-DD>

## Status
Accepted — YYYY-MM-DD

## Context
The real problem, constraint, or observed failure that forced a decision.
Objective and specific. No aspiration, no marketing.

## Decision
What was actually built. Cite concrete paths **plus the symbol name**:
`src/payments/domain/Money.ts` — `Money.fromCents`. Name real tables, columns,
and endpoints. Never a description so vague it could describe any implementation.

## Trade-offs actually evaluated
Include this section **only if real alternatives were considered**. If there was
one reasonable option, say that in a sentence instead. Never invent a strawman
alternative to fill a table.

## Consequences
Positive / Neutral / Negative. State the cost you accepted, not only the win.

## Verification Evidence
The commands actually run and their actual output — type-check result, test
counts, the manual check performed. Never claim a check that was not executed.

## Related Files
A flat list of every central file, each with its relevant symbols:
- `src/payments/application/RefundPayment.ts` — `RefundPayment.execute`
- `src/payments/infrastructure/PrismaPaymentRepository.ts` — `findByReference`
```

Add a Mermaid diagram **only** when a multi-step flow or boundary cannot be
conveyed as clearly in prose. A diagram nobody needed is worse than none.

## Step 4 — Amending an existing ADR: subtract nothing

An ADR is an audit trail, not a current-state document.

- Correct the stale **statement**; then append `## Amendment — YYYY-MM-DD`
  explaining what changed and why.
- **Never delete** a rejected alternative, a recorded consequence, or a
  Related Files entry because it now looks obsolete. That content is exactly
  what stops a future agent from re-proposing an option that already lost.
- A section that no longer applies stays, marked
  `(superseded by the Amendment below)`.
- A path that no longer exists stays in `~~strikethrough~~` with the live
  pointer beside it. A bare dead path is indistinguishable from a mistake.

## Step 5 — Keep the index in sync

`docs/adr/README.md` holds one table row per record: relative link, status,
2–4 lowercase topic tags, and one sentence of decision. The tags are what let a
future agent read the index and open only what matters.

Update the index when an ADR is **created** or its **status changes**. Do not
touch it for internal detail edits — those get an Amendment instead.

## Hard rules

- **Never fabricate.** No invented alternatives, benchmarks, measurements, or
  production status. One real option is a valid answer; a fake table is not.
- **Cite by symbol, never by line number.** `File.ts:61` points at the wrong
  code the moment a line is inserted above it, and a confidently wrong pointer
  is worse than no pointer. `path` + symbol survives every edit and is greppable.
- **One decision per ADR.** Do not bundle unrelated choices.
- **Never write secrets** — no `.env` values, tokens, credentials, private URLs,
  customer data, or PII, not even as an example.
- **Document what exists.** Read the implementation with `safe_read_file` before
  writing the record. An ADR describing code that was never written is a lie
  with a date on it.
- After `safe_write_file`, verify with `safe_read_file`. A described file is not
  a created file.
