---
name: refactor-safely
description: Safely refactor existing code — identify all callers first, change inside-out (domain → presentation), verify integrity after each file
triggers: [refactor, rename, move, extract, restructure, reorganize, migrate, restructure]
---

# Skill: Refactor Safely

> Source: OpenHands + aider battle-tested protocol

## BEFORE touching a single file — mandatory research

```
ask_codebase("who imports [ClassName or FunctionName you're changing]?")
ask_codebase("tests that cover [FileName]?")
list_files("src/[module]/")
```

Write out every file that will change **before** making any edit.
If more than 5 files will change → use `ask_human` to confirm scope with the user.

## Refactoring order: always inside-out

Never start at the controller and work inward — you'll break callers before fixing them.

```
1. Domain layer first   (entities, value-objects, interfaces)
2. Application layer    (use-cases, DTOs, ports)
3. Infrastructure layer (repository implementations, mappers)
4. Presentation layer   (controllers, request DTOs)
5. Module file last     (update providers/imports/exports)
```

## After EACH file change — non-negotiable

```
run_integrity_check()   ← fix ALL TypeScript errors before moving to next file
```

Do NOT accumulate errors across files. One broken file = stop and fix before continuing.

## Safe rename protocol

```
Step 1: Add new name (keep old as alias or deprecated)
Step 2: Update ALL callers to use new name (verify with ask_codebase)
Step 3: Remove old name
Step 4: run_integrity_check — zero errors
```

Never: rename → update some callers → move on. This leaves the codebase in a broken intermediate state.

## Abort conditions

Stop immediately and report to user if:
- More than **5 TypeScript errors** appear after a single file change → undo that file's change
- Tests that were passing before now fail → stop and report which tests broke
- You realize the refactor is larger than initially scoped → ask_human before continuing

## Output format when done

```markdown
## Refactor Complete

**Files changed:** N
**Callers updated:** N  
**run_integrity_check:** ✅ 0 errors
**Tests:** ✅ all passing (N tests)

**What changed:**
- `src/...` — [what changed and why]
- `src/...` — [what changed and why]
```
