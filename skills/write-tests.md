---
name: write-tests
description: Write unit and integration tests for NestJS services and controllers following strict TDD — spec file always before implementation
triggers: [test, spec, TDD, unit test, integration test, coverage, jest]
---

# Skill: Write Tests in NestJS (TDD Protocol)

## Golden rule
**Write the `.spec.ts` file BEFORE the implementation.** Tests define the contract.
If the implementation already exists, read it first — then write tests that cover
every public method, edge case, and error branch.

## File naming
| What you're testing | Spec file name |
|---|---|
| `users.service.ts` | `users.service.spec.ts` (same folder) |
| `users.controller.ts` | `users.controller.spec.ts` (same folder) |
| `create-user.use-case.ts` | `create-user.use-case.spec.ts` (same folder) |

## Test structure template
```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { UsersService } from './users.service';
import { IUsersRepository } from '../domain/repositories/users.repository.interface';

describe('UsersService', () => {
  let service: UsersService;

  // Always mock dependencies — never use real DB in unit tests
  const mockUsersRepository: jest.Mocked<IUsersRepository> = {
    findById: jest.fn(),
    findByEmail: jest.fn(),
    save: jest.fn(),
    delete: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: IUsersRepository, useValue: mockUsersRepository },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  afterEach(() => {
    jest.clearAllMocks(); // Reset mocks between tests — critical
  });

  describe('findById', () => {
    it('should return a user when found', async () => {
      // Arrange
      const userId = 'user-123';
      const mockUser = { id: userId, email: 'test@test.com' };
      mockUsersRepository.findById.mockResolvedValue(mockUser);

      // Act
      const result = await service.findById(userId);

      // Assert
      expect(result).toEqual(mockUser);
      expect(mockUsersRepository.findById).toHaveBeenCalledWith(userId);
    });

    it('should throw NotFoundException when user does not exist', async () => {
      // Arrange
      mockUsersRepository.findById.mockResolvedValue(null);

      // Act + Assert
      await expect(service.findById('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });
});
```

## What to cover — minimum requirements
For every public method, write at least:
- ✅ **Happy path** — the normal success case
- ❌ **Not found / null** — when entity doesn't exist
- ❌ **Duplicate / conflict** — when something already exists
- ❌ **Invalid input** — bad data that should be rejected
- ⚠️ **Repository/service failure** — when a dependency throws

## Controller tests — use supertest style
```typescript
describe('UsersController', () => {
  it('should return 200 with user data', async () => {
    // Mock the service — controllers never touch repos directly
    const mockService = { findById: jest.fn().mockResolvedValue({ id: '1' }) };
    ...
  });

  it('should return 404 when user not found', async () => { ... });
  it('should return 400 for invalid UUID', async () => { ... });
});
```

## Running tests
After writing specs, run:
```
run_tests("src/users/users.service.spec.ts")   ← specific file
run_tests()                                      ← full suite
```

## If tests fail — self-correction protocol
1. Read the error message carefully
2. Re-read the implementation with `safe_read_file`
3. Fix the test OR the implementation (one at a time)
4. Max 3 self-correction attempts, then use `ask_human`
