---
name: create-ddd-module
description: Create a complete NestJS module following strict DDD architecture (Domain, Application, Infrastructure, Presentation layers)
triggers: [module, feature, DDD, create, new service, new module, domain]
---

# Skill: Create DDD Module in NestJS

## Before you start — mandatory research
1. Call `ask_codebase("existing module structure DDD layers")` to find a reference module
2. Call `list_files("src/")` to understand the project layout
3. Read one existing module as a pattern reference with `safe_read_file`

## Mandatory folder structure
Every module MUST follow this exact layout. Never deviate:

```
src/<module-name>/
├── domain/
│   ├── entities/          ← Pure TypeScript classes, no ORM decorators
│   ├── value-objects/     ← Immutable primitives (Email, Money, UserId)
│   ├── repositories/      ← Interfaces only — never implementations
│   └── events/            ← Domain events (if needed)
├── application/
│   ├── use-cases/         ← One class per use case (CreateUser, FindUser)
│   ├── dtos/              ← Input/Output DTOs for use cases
│   └── ports/             ← Interfaces for external services (IEmailService)
├── infrastructure/
│   ├── repositories/      ← Concrete repo implementations (Prisma, TypeORM)
│   ├── mappers/           ← Entity ↔ DB model converters
│   └── persistence/       ← DB schema / ORM models (hidden here, never leak)
├── presentation/
│   ├── controllers/       ← NestJS @Controller classes, return DTOs only
│   └── dtos/              ← Request/Response DTOs with class-validator
└── <module>.module.ts     ← NestJS @Module — wires everything together
```

## Layer rules (non-negotiable)
- **Domain**: zero NestJS imports, zero ORM imports. Pure business logic only.
- **Application**: imports Domain only. No infrastructure concerns.
- **Infrastructure**: implements Domain interfaces. Hidden behind Repository pattern.
- **Presentation**: imports Application DTOs only. Never returns raw DB entities.

## File creation order (always this order)
1. Domain entities and interfaces first
2. Application use-cases and DTOs
3. Infrastructure repositories and mappers
4. Presentation controllers and request DTOs
5. Module file last (registers everything)
6. Update `src/app.module.ts` to import the new module

## TSDoc requirements
Every class, interface, and public method MUST have a TSDoc block:
```typescript
/**
 * Creates a new user in the system.
 *
 * @param dto - The validated input from the presentation layer.
 * @returns The created user's public profile.
 * @throws {UserAlreadyExistsException} If email is already registered.
 */
async execute(dto: CreateUserDto): Promise<UserResponseDto> { ... }
```

## After creating all files
1. Run `run_integrity_check` — fix any TypeScript errors before reporting done
2. If `INFRASTRUCTURE_ERROR` → list missing packages, do NOT retry tsc
3. Update `src/app.module.ts` to import the new module
4. Confirm each file exists with `safe_read_file` before marking step done
