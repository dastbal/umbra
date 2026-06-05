---
name: debug-typescript
description: Systematically debug TypeScript and NestJS errors — read the error first, identify root cause, apply minimal fix
triggers: [error, bug, crash, fix, broken, exception, TS2307, TS2345, TS2339, undefined, cannot read, injection]
---

# Skill: Debug TypeScript & NestJS Errors

## Step 1 — Read the full error before touching anything
Never guess. Never change code without reading the error first.
```
run_integrity_check()   ← for TypeScript compiler errors
run_tests()             ← for runtime test failures
```
Copy the exact error message. Identify:
- **Error code** (TS2307, TS2345, etc.)
- **File and line number**
- **What TypeScript expected vs. what it got**

## Common TypeScript error codes

| Code | Meaning | Most common cause |
|---|---|---|
| `TS2307` | Cannot find module | Missing `npm install`, wrong import path, missing `@types/` |
| `TS2345` | Argument not assignable | Wrong type passed to function — check the interface |
| `TS2339` | Property does not exist | Typo in property name, or missing from interface |
| `TS2304` | Cannot find name | Variable not imported, or out of scope |
| `TS2564` | Not definitely assigned | Property declared but not initialized in constructor |
| `TS1005` | Expected token | Syntax error — missing `;`, `}`, `)` |

## Step 2 — Read the affected file before changing it
```
safe_read_file("src/path/to/affected-file.ts")
```
Understand WHY the code is there before removing or changing it.
Anti-regression rule: never delete code without knowing what it does.

## Step 3 — Apply the minimal fix
Fix ONLY what the error report says. Do not refactor unrelated code.

**For TS2307 (Cannot find module):**
- Check if it's a missing npm package → tell user to run `npm install`
- Check if it's a wrong relative path → fix the import path
- Check if it's a missing type declaration → `npm install --save-dev @types/package`

**For TS2345 (Wrong type):**
- Read the interface/type definition
- Check if the DTO is missing a field or has the wrong type
- Check if you're passing the full object where only a partial is expected

**For NestJS injection errors (`Nest can't resolve dependencies`):**
- The provider is missing from the module's `providers` array
- Or the module importing it hasn't added it to `imports`
- Read `*.module.ts` and verify the providers list

## Step 4 — Verify the fix
```
run_integrity_check()   ← zero TypeScript errors required
run_tests()             ← no regressions
```

## If `run_integrity_check` returns `INFRASTRUCTURE_ERROR`
The error is about missing npm packages — you CANNOT fix it by editing code.
Do NOT retry `run_integrity_check`. Tell the user:
```
The following packages need to be installed:
npm install <package1> <package2>
```

## Self-correction limit
3 attempts maximum. If the error persists after 3 tries → use `ask_human`.
Describe: what you tried, what the error says, what you expected.
