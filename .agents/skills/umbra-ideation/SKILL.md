---
name: umbra-ideation
description: >
  Opens a mandatory divergence phase before planning any Umbra feature, so this repository keeps
  being built by invention rather than by ticket. Produces three convergent ideas, three lateral
  ones, and one heretical one that contradicts an accepted ADR; then hands the question back to
  David and asks what idea he has been carrying around. Nothing chosen is discarded — it falls into
  docs/deferred-work.md in the format this repo already uses.
  Triggers in the nestjs-ai-agent-lib (@dastbal/umbra) repository when the user says: "qué le
  agregamos", "estaba pensando en", "cómo mejoramos X", "se me ocurrió", "quiero una feature",
  "qué te parece si", "tirame ideas", "dame ideas", "pensemos", "qué más podría hacer", "hagamos
  algo innovador", "what should we build", "give me ideas", "brainstorm", "let's plan".
  ALSO run it unprompted at the end of any session that shipped a feature here — that is when the
  next idea is closest to the surface and cheapest to record.
  Do NOT use this skill for a bug fix, a type error, a test repair, a rename, a release, or any
  task where the goal is already fully specified: say the exit line and plan normally.
---

# Umbra Ideation — the divergence ritual

This skill exists for one repository only: `@dastbal/umbra` (`nestjs-ai-agent-lib`), on branch `2.0.0`.

It is not a checklist. It changes the posture Claude takes during planning here — from the prudent engineer who validates invariants to the partner who proposes what was not asked for.

---

## Why this skill exists — read this before the protocol

This project's three defining ideas did not come from a ticket. They came out of nowhere while David was working:

| Idea | Where it lives now |
|---|---|
| Subagents / delegated topology | `docs/adr/ADR-001-agent-orchestration-context.md` |
| Decision records as agent-readable context | `docs/adr/ADR-004-on-demand-adr-index.md` — `list_adrs` |
| Indexing with RAG to search faster (`askrag`) | `src/core/rag/`, `docs/adr/ADR-003-on-demand-readme-index.md` |

None of them was requested. All three are now load-bearing. **That is the actual development process of this repository**, and a default assistant posture — wait for the spec, implement the spec — suppresses it precisely when it is most valuable.

The second observed fact: David already invented the mechanism for not losing ideas. `docs/deferred-work.md` holds ideas that were scoped, investigated, and deliberately not built, with enough detail to resume without repeating the work. What was missing was the ritual that *feeds* it.

**So: this skill diverges first, and captures what it does not build.**

---

## Honest limit — state this if the topic comes up

This skill **cannot raise Claude's sampling temperature**. That is a model parameter no skill can reach. What it changes is posture and obligation: diverge before converging, propose the unrequested, hand the question back. The felt effect is the one David asked for; the mechanism is instruction, not sampling. Never claim otherwise.

---

## The exit door — check this FIRST

Run this ritual **only when the goal is not already specified**. If the task is a bug fix, a type error, a failing test, a rename, a build or release, or anything where David already knows exactly what he wants, say one line —

> *Esto es trabajo cerrado, no abro divergencia. Voy directo.*

— and plan normally. A ritual that fires on every fix becomes friction, and friction is how a skill gets disabled. Firing at everything and never firing are equally useless.

---

## The protocol

### PHASE 0 — Load the invention context (cheap, always do it)

Read, in this order, and read **only** these:

1. `docs/deferred-work.md` — in full. It is short and it is the idea backlog. **Every entry here is a live proposal**, not history. As of 2026-08-27 it holds: `ask_human` with multiple choice (carrying an open defect — the tool is advertised in the Deep Agent prompt but registered nowhere), and one base prompt for three modes that declare different tools.
2. `docs/adr/README.md` — the **index table only**. Match the topic against the `Tags` column and open only matching records. Never read all fourteen; that is the context spend `ADR-004` exists to avoid.
3. `AGENTS.md` — only if the session has not already established the conventions.

Do not explore `src/` yet. Exploring source before diverging anchors the ideas to what already exists, which is exactly the failure this phase is designed to avoid.

### PHASE 1 — Diverge. Seven candidates, no fewer

Produce **seven** ideas, in three named groups. Do not rank them yet. Do not evaluate feasibility yet. Evaluation during generation is what kills the heretical idea, and the heretical idea is the one that built this project.

**Three convergent** — the obvious next step from where the code already is. These are the safe ones; name them so the good ones have contrast, not to fill a quota.

**Three lateral** — apply the lenses in [references/invention-lenses.md](references/invention-lenses.md). Each lateral idea must state which lens produced it. Lenses are the substitute for a temperature knob: they force a different starting point instead of hoping for a different output from the same one.

**One heretical** — an idea that **contradicts an accepted ADR of this repository**. Name the ADR and the claim it breaks. This is mandatory and it is the highest-value slot in the whole ritual: an accepted decision nobody is allowed to question quietly becomes an assumption, and assumptions are where the next invention is buried. Proposing it is not disloyalty to the record — the ADR protocol has `Superseded by` for exactly this.

Each candidate gets, at most, four lines: what it is, what in Umbra it would touch (a real path from the table below), why it might be beautiful, and the one thing that could make it worthless.

### PHASE 2 — Hand the question back

Never go from Phase 1 straight to a plan. Ask David — explicitly, in Spanish, and in his terms:

- *¿Qué idea tenés dando vueltas que todavía no me contaste?*
- Then one **specific** provocation drawn from what Phase 0 actually showed, never a generic prompt for ideas. Example shape: *"`ask_human` está anunciado en el prompt y registrado en ningún lado — ¿y si en vez de arreglarlo, el agente pudiera preguntarte con opciones y eso se convirtiera en cómo aprende tus preferencias?"*

The provocation must cite something real that was just read. A generic *"¿alguna otra idea?"* wastes the phase.

### PHASE 3 — Converge, once he chooses

Only now: pick up the standard engineering posture. Verify against the source, respect the DDD boundaries in `AGENTS.md`, plan the tests (`npm run test:unit` / `test:integration` / `test:contracts` / `test:e2e`), and identify which ADR gets written or amended. The creative phase is over; do not keep generating.

### PHASE 4 — Nothing chosen is thrown away

Every candidate David found interesting but did not pick goes into `docs/deferred-work.md`, in the format already there: what the idea is, what is actually broken today, the mechanism to reuse, the plan. Follow [references/the-idea-bank.md](references/the-idea-bank.md) for the entry shape and the rules.

An idea that was generated and lost cost the same to produce as one that was recorded.

---

## Umbra's real subsystems

Verified by directory listing on 2026-08-27. Use these when naming what an idea would touch; never invent a path.

| Subsystem | Path | What it governs |
|---|---|---|
| Agent core / factory | `src/core/agent/` | Deep agent construction, middlewares, orchestration guard |
| Subagents | `src/core/subagents/` | Delegated topology (ADR-001, ADR-013) |
| RAG / indexes | `src/core/rag/` | `askrag`, README and ADR indexes (ADR-003, ADR-004) |
| LLM providers | `src/core/llm/` | Vertex, Ollama, routing (ADR-002, ADR-006) |
| Tools | `src/core/tools/` | What the model can actually call |
| Security | `src/core/security/` | Policy, path containment, approval (ADR-009, ADR-011) |
| State / sessions | `src/core/state/` | Checkpoints, recovery (ADR-005, ADR-007) |
| Observability | `src/core/observability/` | Traces, telemetry, flush (ADR-008) |
| Interaction | `src/core/interaction/` | Human-in-the-loop surface |
| CLI | `src/presentation/cli/` | Prompt engine, line editor, palette, renderers (ADR-012 arrow keys) |
| Shipped skills | `skills/` | What the package hands the consumer (ADR-012 shipped guides) |

---

## Guardrails

| ❌ Never | ✅ Instead |
|---|---|
| Skip the heretical idea because everything looks settled | It is mandatory. A repo with fourteen accepted ADRs has fourteen assumptions worth poking |
| Evaluate feasibility during Phase 1 | Generate all seven first. Evaluation during generation kills the interesting one |
| Run the ritual on a bug fix or a release | Use the exit door and say so in one line |
| Read all of `src/` before diverging | Phase 0 only. Source anchors ideas to the present |
| Ask a generic "¿alguna otra idea?" | Cite something real that Phase 0 just surfaced |
| Answer "buena idea" and stop | Add something: a consequence, a sharper version, or the reason it fails |
| Invent a path, an ADR number, or a benchmark to make an idea sound grounded | Cite only what was read. A fabricated grounding is worse than an ungrounded idea |
| Let an unchosen idea evaporate | Phase 4. `docs/deferred-work.md` |
| Claim the temperature was raised | Say what actually changed: posture and obligation |

---

## How do I know this worked?

Three checkable signals, in order of importance:

1. **The heretical idea was named and its ADR cited.** If Phase 1 produced seven safe ideas, the ritual ran but did nothing.
2. **David was asked a specific question grounded in what Phase 0 read** — not a generic invitation.
3. **`docs/deferred-work.md` grew, or there was an explicit decision not to record anything.** A session that generated seven ideas and recorded none lost six.

The failure mode to watch for: the ritual firing on closed work. If David has to say *"esto era un fix"*, the exit door was not checked first.

---

*Created 2026-08-27 by Claude, at David's request, for this repository only.*

*Facts verified that day: subsystem paths by directory listing; the ADR set and its fourteen rows by `docs/adr/README.md`; the deferred-work entries by reading the file; the test scripts by `package.json`. The `ask_human` defect is quoted as `docs/deferred-work.md` records it, not re-verified against source.*
