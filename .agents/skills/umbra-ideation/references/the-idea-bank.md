# The idea bank — Phase 4

Load this when recording what the ritual generated but did not build.

## Where it goes

`docs/deferred-work.md`, in the repository root's `docs/`. **This file already exists and already has a format.** Do not invent a new one, do not create a second file, and do not reorder or rewrite what is there.

Its own header states why it is versioned: *"a finding that lives only in a machine-local save state is a finding that disappears with the disk."* That reasoning applies to ideas exactly as it applies to defects.

## What earns an entry

Record an idea when **both** hold:

- David showed real interest — asked a follow-up, sharpened it, or said to keep it.
- There is something concrete to resume from: a mechanism that already exists, a defect it would close, or a decision it would reverse.

Do **not** record:

- The convergent ideas nobody reacted to. Seven entries per session turns the file into noise and the file's value is that everything in it is live.
- An idea with nothing to resume from. *"Make the agent smarter"* is not resumable. If it cannot name a subsystem, it is not ready for the bank — say so instead of padding it.

When in doubt, ask David whether it goes in. That is one line and it beats both a lost idea and a bloated file.

## The entry shape

Match the existing entries. Reading one of them before writing is cheaper than reconstructing the format from this document.

```markdown
## <short title, what the idea is>

> Recorded YYYY-MM-DD, branch `<branch>`. Deferred by David in the session that
> found it: <one line on why that session did not do it>.

### The idea

<What it is, in two or three sentences. Written for someone with zero context.>

### The open defect this would close

<Only if there is one. State it as fact with evidence — a table of
claim/evidence is the shape already used in this file. If there is no defect,
delete this section rather than inventing one.>

### The mechanism to reuse

<What already exists that this would build on: real paths, real symbols, and the
ADR that decided it. This is the section that makes the idea resumable.>

### The plan

<The steps, at the altitude they were actually reasoned to. If it was never
planned past a sketch, say so — an honest sketch is resumable, a fabricated
plan sends the next session down a path nobody evaluated.>
```

## Rules that override tidiness

- **Cite by path plus symbol, never by line number.** `src/core/agent/deep-agent-factory.ts` plus the symbol name survives edits above it; `deep-agent-factory.ts:214` rots the moment anyone inserts a line, and a stale pointer is worse than none because it sends the next session to confidently read the wrong code.
- **Never delete an entry to make room.** When one gets implemented, move it out and record the decision as an ADR — that is what the file's header already instructs. An entry marked built stays discoverable; see the `/` command palette entry, kept and marked **built 2026-08-26** rather than removed.
- **Absolute dates only.** *"Last week"* is unreadable in three months.
- **English in the file.** It is versioned in the repository. The conversation with David stays in Spanish.
- **Do not claim verification that did not happen.** If the defect an idea would close was read from another document rather than confirmed in source, say which.

## After writing

Tell David, in one line, what was recorded and where — so he can veto it in the same breath. An entry added silently to a versioned file is a change he did not approve.
