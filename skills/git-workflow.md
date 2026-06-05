---
name: git-workflow
description: Git branching, commit messages, and versioning protocol — when and how to commit, branch naming, and what never to commit
triggers: [git, commit, branch, push, merge, version, release, tag, PR, pull request]
---

# Skill: Git Workflow

> Source: Claude Code system prompt patterns + conventional commits standard

## Branch naming — version number = branch name

```
✅ Correct:  1.4.1  (patch: bug fix)
✅ Correct:  1.5.0  (minor: new feature, backward compatible)
✅ Correct:  2.0.0  (major: breaking change)
❌ Wrong:    feat/users-module
❌ Wrong:    fix/auth-bug
❌ Wrong:    david-working-branch
```

**When to bump version:**
- Bug fix only → patch (`1.3.0` → `1.3.1`)
- New feature, no breaking changes → minor (`1.3.0` → `1.4.0`)
- Breaking change in public API → major (`1.3.0` → `2.0.0`)

## Commit message format — Conventional Commits

```
<type>(<scope>): <short summary>

[optional body — what and why, not how]

[optional footer — breaking changes, closes issues]
```

**Types:**
| Type | When |
|---|---|
| `feat` | New feature |
| `fix` | Bug fix |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `test` | Adding or fixing tests |
| `docs` | Documentation only |
| `chore` | Build, tooling, dependencies |
| `perf` | Performance improvement |

**Good examples:**
```
feat(users): add create-user endpoint with email validation

fix(auth): resolve JWT expiry not being checked on refresh

refactor(calculator): move business logic from controller to service
```

**Bad examples:**
```
fix stuff          ← too vague
WIP                ← never commit WIP to main
updated files      ← describes nothing
```

## What to NEVER commit

```
❌ .env files (any environment)
❌ node_modules/
❌ dist/ or build/ output
❌ *.log files
❌ Files with hardcoded passwords, API keys, secrets
❌ Broken TypeScript (zero errors required before commit)
❌ Failing tests (all tests must pass before commit)
```

## Pre-commit checklist

Before every commit, verify:

```
run_integrity_check()   ← 0 TypeScript errors required
run_tests()             ← all tests passing
```

If either fails → do NOT commit. Fix first.

## Staging — commit atomically

Each commit should represent **one logical change**. Do not mix:
- Feature A and Feature B in one commit
- Bug fix and refactor in one commit
- Working code and broken code in one commit

```bash
# Stage specific files (not git add .)
git add src/users/users.service.ts src/users/users.service.spec.ts
git commit -m "feat(users): add findByEmail use case with validation"
```

## When to ask human before committing

Always ask before:
- Bumping `package.json` version
- Pushing to `main` or merging a branch
- Creating a git tag or release
- Any `--force` push

## After a successful commit

Report the commit hash:
```markdown
**Committed:** `abc1234` — feat(users): add findByEmail use case
```
