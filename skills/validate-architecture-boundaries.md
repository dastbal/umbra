---
name: validate-architecture-boundaries
description: Validate that code respects DDD layer boundaries — detect forbidden imports, ORM leaking into domain, raw entities in controllers
triggers: [import, boundary, layer, leak, domain, infrastructure, typeorm, prisma, entity, violation, architecture check]
---

# Skill: Validate Architecture Boundaries

> Source: awesome-cursorrules (most starred NestJS rules) + cursor.directory Clean Architecture section
> The Dependency Rule is INVIOLABLE: Infrastructure → Application → Domain (one direction only)

## The Dependency Rule

```
✅ ALLOWED import directions:
  Infrastructure  →  Application  →  Domain
  Presentation    →  Application  →  Domain

❌ FORBIDDEN import directions:
  Domain          →  Application         (domain must be pure)
  Domain          →  Infrastructure      (domain must be pure)
  Application     →  Infrastructure      (application must not know implementations)
  Domain          →  Presentation        (domain must be pure)
```

## Forbidden patterns — scan for these

Run these `ask_codebase` queries to find violations:

```
ask_codebase("import from typeorm inside domain/")
ask_codebase("import from prisma inside domain/")
ask_codebase("import from infrastructure inside domain/")
ask_codebase("import from infrastructure inside application/")
ask_codebase("@Entity decorator inside domain/entities/")
ask_codebase("@Column decorator inside domain/")
```

## The forbidden patterns list

### ❌ ORM in Domain layer
```typescript
// FORBIDDEN — domain entity with TypeORM decorators
import { Entity, Column, PrimaryGeneratedColumn } from 'typeorm'; // ← forbidden in domain/
@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column() email: string;
}

// ✅ CORRECT — pure domain entity
export class User {
  constructor(
    public readonly id: string,
    public readonly email: string,
  ) {}
}
```

### ❌ Raw DB entities returned from controllers
```typescript
// FORBIDDEN — controller returns raw Prisma/TypeORM object
@Get(':id')
async getUser(@Param('id') id: string) {
  return this.usersRepository.findById(id); // ← returns DB model, not DTO
}

// ✅ CORRECT — controller returns DTO only
@Get(':id')
async getUser(@Param('id') id: string): Promise<UserResponseDto> {
  const user = await this.usersService.findById(id);
  return UserResponseDto.from(user); // ← explicit mapping
}
```

### ❌ Infrastructure repository injected directly in controller
```typescript
// FORBIDDEN — controller knows about infrastructure
constructor(private readonly prismaUsersRepo: PrismaUsersRepository) {} // ← wrong

// ✅ CORRECT — controller only knows application service
constructor(private readonly usersService: UsersService) {}
```

### ❌ Application service imports infrastructure directly
```typescript
// FORBIDDEN — application knows implementation details
import { PrismaUsersRepository } from '../../infrastructure/repositories/prisma-users.repository';

// ✅ CORRECT — application only knows the interface (port)
import { IUsersRepository } from '../domain/repositories/users.repository.interface';
```

### ❌ NestJS injection in Domain
```typescript
// FORBIDDEN — domain has NestJS dependency
import { Injectable } from '@nestjs/common'; // ← forbidden in domain/
@Injectable()
export class User { ... }
```

## Auto-fix protocol for each violation

| Violation | Fix |
|---|---|
| ORM decorator in domain/ | Create a separate `infrastructure/persistence/user.orm-entity.ts` with the decorators. Domain entity stays pure. |
| Raw entity in controller | Create `UserResponseDto` with a static `from(entity: User)` mapper method. |
| Infrastructure imported in application | Extract the interface to domain/repositories/, have application import the interface. |
| NestJS decorator in domain entity | Remove it. Domain entities are plain TypeScript classes. |

## Validation report format

```markdown
## Architecture Boundary Validation

**Violations found:** N

### Critical (fix before any commit):
- ❌ `src/users/domain/entities/user.entity.ts:3` — ORM import in domain layer
  Fix: Move TypeORM decorators to `src/users/infrastructure/persistence/user.orm-entity.ts`

### Passed:
- ✅ No direct infrastructure imports in application layer
- ✅ All controllers return DTOs (not raw entities)
- ✅ Domain entities have zero NestJS/ORM imports
```
