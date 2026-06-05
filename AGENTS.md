# AGENTS.md — Project Context for AI Agents

> This file is for AI agents, not humans. For human project history see `ANTIGRAVITY.md`.
> Read this file at the start of every session to understand the project's conventions.

## What this project is

A NestJS AI agent library (`@dastbal/nestjs-ai-agent`) that helps developers build
autonomous coding agents for their NestJS projects. The agent can analyze, implement,
test, and refactor NestJS code autonomously following DDD architecture.

## Core technology stack

```
Backend:    NestJS (TypeScript, strict mode)
ORM:        TypeORM or Prisma (hidden behind Repository Pattern)
Agent:      deepagents (LangGraph-based) + LangChain
LLMs:       Vertex AI (Gemini) or Ollama (local models)
Embeddings: Vertex AI text-embedding-004 (always, regardless of chat model)
Testing:    Jest with ts-jest
```

## Architecture — DDD (Domain-Driven Design)

Every feature module follows this exact structure:

```
src/<module>/
├── domain/           ← Pure TypeScript, zero NestJS/ORM imports
│   ├── entities/
│   ├── value-objects/
│   └── repositories/ ← Interfaces only
├── application/      ← Business logic, imports only Domain
│   ├── use-cases/
│   └── dtos/
├── infrastructure/   ← Implementations, hidden behind interfaces
│   └── repositories/
└── presentation/     ← Controllers, returns DTOs only
    ├── controllers/
    └── dtos/
```

**The inviolable rule:** Infrastructure → Application → Domain (one direction only).

## Skills available

The agent has 11 skills in `skills/`. They are loaded by keyword detection.
Never edit these files — they are read-only guidelines.

| Skill | When to use |
|---|---|
| `create-ddd-module.md` | Creating new NestJS modules |
| `write-tests.md` | Writing Jest specs (TDD) |
| `refactor-safely.md` | Refactoring existing code |
| `create-endpoint.md` | Adding REST endpoints |
| `debug-typescript.md` | Fixing TypeScript errors |
| `analyze-codebase.md` | Read-only code review |
| `evaluate-own-work.md` | Self-review before "done" |
| `git-workflow.md` | Committing, branching, versioning |
| `security-audit.md` | Security review |
| `research-output-format.md` | Structured Researcher → Coder handoff |
| `validate-architecture-boundaries.md` | DDD layer validation |

## Key commands

```bash
# Run the agent
npm run agent -- deep                         # ephemeral session
npm run agent -- deep --session <name>        # named persistent session

# Verify code
npm run type-check                            # zero TS errors required
npm test                                      # all tests must pass

# Switch LLM
$env:AGENT_MODEL="gemini-2.5-flash"; npm run agent -- deep
$env:AGENT_MODEL="ollama:gemma4"; npm run agent -- deep
```

## Conventions

- **No `any` types** — use `unknown` + type guards instead
- **TSDocs** on every class, interface, and public method
- **Branch = version number** (e.g., `1.4.0`) — no `feat/` or `fix/` prefixes
- **Commit format**: `type(scope): description` (Conventional Commits)
- **Tests before implementation** (TDD) — `.spec.ts` created first

## What to NEVER do

- Edit `skills/*.md` files (read-only)
- Edit `ANTIGRAVITY.md` (human-maintained)
- Return raw DB entities from controllers
- Import ORM/Infrastructure in Domain layer
- Commit with TypeScript errors or failing tests
- Use `any` type
