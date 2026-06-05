---
name: analyze-codebase
description: Deeply analyze the codebase structure, patterns, and architecture without writing any code — read-only exploration and structured reporting
triggers: [explain, understand, analyze, how does, what is, why, overview, architecture, review, summarize, audit]
---

# Skill: Analyze Codebase (Read-Only Mode)

## Prime directive
In this mode you ONLY read. You do NOT write, modify, or delete any files.
Every finding must be backed by a direct quote or file reference.
Never speculate — if you don't find evidence, say so.

## Step 1 — Get the high-level picture
```
list_files("src/")                    ← overall structure
list_files("src/<module>/")          ← specific module if relevant
ask_codebase("what is the main architecture pattern used?")
ask_codebase("what are the main modules in this project?")
```

## Step 2 — Identify key files
For each relevant module, read in this order:
1. The `*.module.ts` file — understand what's registered
2. Domain entities — understand the core data model
3. Application use-cases — understand the business logic
4. Controllers — understand the public API surface

## Step 3 — Look for patterns and conventions
```
ask_codebase("how are repositories implemented?")
ask_codebase("how are DTOs structured?")
ask_codebase("error handling patterns used")
ask_codebase("authentication and authorization approach")
```

## Step 4 — Identify risks and issues (if asked)
Look for:
- `any` types — potential type safety holes
- Missing TSDocs — undocumented public APIs
- ORM types leaking into application layer
- Missing `.spec.ts` files for services and controllers
- Circular dependencies (module A imports module B which imports A)

## Output format — always structured
Report findings with this structure:

```markdown
## Architecture Overview
[Summary of the overall pattern — DDD, layered, hexagonal, etc.]

## Module Map
- `src/auth/` — Authentication (JWT, guards, strategies)
- `src/users/` — User management

## Key Patterns Found
- **Repository pattern**: [yes/no + example file]
- **DTO layer**: [yes/no + example file]
- **Error handling**: [approach + example]

## Observations
- ✅ [Good pattern found]
- ⚠️ [Something to be aware of]
- ❌ [Issue that should be addressed]

## Files Referenced
- [src/users/users.module.ts](src/users/users.module.ts)
- ...
```

## Hard rules for this skill
- Zero `safe_write_file` calls — read only
- Every claim must cite a file: `"In src/users/users.service.ts line 42..."`
- If asked to also fix something → finish the analysis first, then ask the user
  if they want to proceed with fixes before writing any code
