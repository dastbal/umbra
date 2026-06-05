---
name: research-output-format
description: Mandatory output format for the Researcher subagent — structured implementation plan that the Coder can parse and execute without ambiguity
triggers: [research done, implementation plan, ready to code, handoff, plan for coder, coder will]
---

# Skill: Research Output Format (Researcher → Coder Handoff)

> Source: MetaGPT SOP as Code concept — structured artifacts between agents
> The Researcher MUST output in this exact format. Prose-free handoff prevents misinterpretation.

## Why this matters

Unstructured handoff = "Build a UsersModule following DDD with the usual patterns."
Structured handoff = exact files, exact paths, exact method signatures, exact risks.
The Coder should be able to implement without re-reading the codebase.

## Mandatory output template

Copy this template and fill every section. Do not skip sections.

```markdown
## IMPLEMENTATION PLAN

### Task Summary
[1-2 sentences: what needs to be built and why]

### Reference Module
[Path to an existing similar module the Coder should follow as pattern]
Example: `src/auth/` — same DDD structure, same injection pattern

---

### Files to CREATE
| File path | DDD Layer | Purpose |
|---|---|---|
| `src/users/domain/entities/user.entity.ts` | Domain | Core User entity, no ORM imports |
| `src/users/domain/repositories/users.repository.interface.ts` | Domain | Repository contract |
| `src/users/application/use-cases/create-user.use-case.ts` | Application | Create user logic |
| `src/users/application/dtos/create-user.dto.ts` | Application | Use-case input/output |
| `src/users/infrastructure/repositories/prisma-users.repository.ts` | Infrastructure | Prisma implementation |
| `src/users/presentation/controllers/users.controller.ts` | Presentation | REST endpoints |
| `src/users/presentation/dtos/create-user-request.dto.ts` | Presentation | class-validator DTO |
| `src/users/users.module.ts` | Module | NestJS wiring |

### Files to MODIFY
| File path | What changes | Risk level |
|---|---|---|
| `src/app.module.ts` | Add `UsersModule` to imports | Low |

---

### Key Interfaces & Signatures
[The Coder must implement these exactly — no guessing]

```typescript
// IUsersRepository
interface IUsersRepository {
  findById(id: string): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
  save(user: User): Promise<User>;
  delete(id: string): Promise<void>;
}

// CreateUserUseCase
class CreateUserUseCase {
  async execute(dto: CreateUserInputDto): Promise<UserOutputDto>
}
```

---

### Implementation Order
[Coder must follow this exact sequence — inside-out]
1. `user.entity.ts` — domain entity first, no dependencies
2. `users.repository.interface.ts` — contract before implementation
3. `create-user.use-case.ts` — business logic using the interface
4. `prisma-users.repository.ts` — concrete implementation
5. `users.controller.ts` + request DTO — presentation last
6. `users.module.ts` — wire everything
7. `src/app.module.ts` — register the new module

---

### Dependencies
- **External packages needed:** `[none / @nestjs/swagger / etc.]`
- **Internal modules to import:** `[DatabaseModule for Prisma / AuthModule for guards / etc.]`
- **Missing that need to be created first:** `[none / SharedModule / etc.]`

---

### Tests Required
| Test file | What to test |
|---|---|
| `users.service.spec.ts` | findById happy path, findById not found, save, duplicate email |
| `users.controller.spec.ts` | POST 201, POST 400 validation, GET 200, GET 404 |

---

### Risks & Watch-outs
- [Specific architectural concern the Coder should be aware of]
- [Potential circular dependency or injection issue]
- [Edge case in the business logic]
```

## What happens if the format is incomplete

The Coder should reject an incomplete plan by responding:
```
"The implementation plan is missing [sections]. I need [X] before I can implement safely."
```

Then ask the user to re-run the Researcher with the correct format.
