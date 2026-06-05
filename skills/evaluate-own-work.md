---
name: evaluate-own-work
description: Self-review checklist before reporting a task as complete — the Evaluator-Optimizer pattern. Run this before saying "done".
triggers: [done, complete, finished, ready, implemented, created, deployed]
---

# Skill: Evaluate Own Work (Self-Review Before Done)

> Source: Anthropic "Building Effective Agents" — Evaluator-Optimizer pattern (Dec 2024)
> The agent that implements also audits. Do not report completion with known issues.

## The rule: never say "done" without running this checklist

Before writing your final response to the user, run every item below.
If any item fails → fix it first, then check again.

## Checklist

### Compilation
```
run_integrity_check()   ← must return zero TypeScript errors
```
If `INFRASTRUCTURE_ERROR` → list the missing packages and tell the user. Do not mark done.

### Tests
```
run_tests()   ← all tests must pass
```
If tests fail → self-correct (max 3 attempts). If still failing → explain why before reporting.

### Code quality — scan every file you wrote

Read each file you created/modified with `safe_read_file` and verify:

- [ ] **No `any` types** — not even `as any`. Use `unknown` + type guard instead.
- [ ] **No raw DB entities** returned from controllers — always map to a response DTO.
- [ ] **No ORM imports in Domain layer** — `TypeORM`, `Prisma` imports only in `infrastructure/`.
- [ ] **Every new class has TSDocs** — `/** ... */` block on the class declaration.
- [ ] **Every new public method has TSDocs** — `@param`, `@returns`, `@throws`.
- [ ] **No `TODO` or `FIXME` comments** left in code — resolve them or delete them.
- [ ] **No `console.log` statements** — use NestJS `Logger` instead.

### Integration
- [ ] **`app.module.ts` updated** if you created a new module (check with `safe_read_file`).
- [ ] **New routes visible** — if you created a controller, verify it's registered in the module.
- [ ] **DTOs have `@ApiProperty`** — all response DTOs are documented for Swagger.

### Disk verification
- [ ] Every file you planned to create **exists on disk** — verify with `safe_read_file`.
  Count your `safe_write_file` calls. 5 files planned = 5 calls made.

## Output format — your final report to the user

```markdown
## ✅ Task Complete — Self-Review Passed

**Files created:** N
**Files modified:** N
**Tests:** N passing, 0 failing
**TypeScript:** 0 errors
**Quality checks:** all passed

**Summary of changes:**
- [file]: [what was done and why]
```

If anything in the checklist failed and you had to fix it, mention it:
```markdown
**Issues found and fixed during self-review:**
- Found `any` type in `user.service.ts` → replaced with `unknown` + type guard
```
