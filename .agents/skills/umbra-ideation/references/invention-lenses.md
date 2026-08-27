# Invention lenses — the substitute for a temperature knob

Load this during **Phase 1**, for the three lateral candidates. Each lateral idea must name the lens that produced it.

## Why lenses instead of "be more creative"

A skill cannot change the sampling temperature. What it can change is the **starting point**. Asking for a different output from the same starting point mostly returns the same output with different words; asking the question from a deliberately displaced position returns something else.

Each lens below is a displacement. Pick three that are *not* obviously suited to the topic — the lens that fits best produces the idea already implied by the topic, which is the convergent group's job.

---

## The lenses

### 1. Invert who asks

Umbra's default direction is: David asks, the agent answers. Invert it. What would the agent ask, when, and what would it do with the answer? What if a question were a first-class artifact that persists across sessions?

*Displaces:* `src/core/interaction/`, `src/presentation/cli/prompts.ts`

### 2. The agent that observes itself

Umbra already emits traces and bounded-iteration telemetry (ADR-008). Those exist for a human to read afterwards. What if the agent read them **about itself, during the run**? What decision would it make differently at iteration 12 knowing what iterations 1–11 cost?

*Displaces:* `src/core/observability/`, `src/core/agent/`

### 3. Context as the product

The `askrag`, README and ADR index ideas all share one shape: the valuable thing was not the answer, it was **the cheap index that made the answer findable**. Apply that shape to something in Umbra that is not yet indexed. What is currently re-derived from scratch on every run?

*Displaces:* `src/core/rag/`

### 4. The human as a tool the model can call

Not human-in-the-loop as a gate that blocks, but the human as an entry in the tool registry with a cost, a latency and a return type like any other. What changes when asking David is something the model *budgets* rather than something it *escalates to*?

*Displaces:* `src/core/tools/`, `src/core/security/`

### 5. Borrow from another discipline

Ask how a different kind of system solves the same structural problem, and take the mechanism, not the metaphor:

- **A compiler** — passes, intermediate representation, fixpoint iteration, diagnostics with source spans
- **A database** — transactions, rollback, query planning with cost estimates, indexes
- **An operating system** — scheduling, isolation, resource quotas, signals
- **A game engine** — fixed tick, interpolation, level-of-detail by distance
- **Version control** — branching, merging, three-way diff, blame

*Displaces:* anything. This is the widest lens and the most likely to produce something genuinely new.

### 6. Delete the load-bearing thing

Pick the piece of Umbra that looks least removable and remove it. No CLI. No system prompt. No session state. No subagents. What does the system become? Sometimes the answer is *worse and instructive*; occasionally the answer is that the piece was carrying an assumption, not a requirement.

*Displaces:* whatever was deleted.

### 7. Scale to absurdity in both directions

One thousand subagents. One subagent with no tools. A ten-million-token context. A 500-token context. Constraints at the extremes expose which parts of the design were general and which were tuned to the middle case.

*Displaces:* `src/core/subagents/`, `src/core/llm/`

### 8. The failure as the feature

Umbra has decisions built entirely out of things that broke: the Vertex streaming rejection (ADR-006), self-healing sessions (ADR-007), checkpoint recovery (ADR-005). Take a current failure mode and ask what it would look like as an intentional capability rather than a fault to survive.

*Displaces:* `src/core/state/`, `src/core/llm/`

---

## Using them

1. Pick three lenses that do not obviously fit the topic.
2. Generate one idea per lens. State the lens by name.
3. Do not filter. A lens that produced something absurd still gets reported — the absurd version is often one step from the good one, and David is the one who decides.

## What these lenses are not

They are not a matrix to exhaust. Running all eight produces volume, not insight, and turns the ritual into the mechanical generator that was deliberately rejected when this skill was designed. Three per session.
