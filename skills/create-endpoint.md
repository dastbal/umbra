---
name: create-endpoint
description: Create a REST endpoint with NestJS Controller, DTO validation (class-validator), and Swagger documentation
triggers: [endpoint, route, REST, GET, POST, PUT, DELETE, PATCH, controller, DTO, API, swagger]
---

# Skill: Create REST Endpoint in NestJS

## Before you start
1. `ask_codebase("existing controller patterns")` — find a reference controller
2. `safe_read_file("src/app.module.ts")` — confirm the module is registered
3. Check if the service/use-case for this endpoint already exists

## Required packages
These must be installed for validation and Swagger to work:
- `class-validator` — `@IsString()`, `@IsEmail()`, `@IsUUID()`, etc.
- `class-transformer` — `@Transform()`, `@Type()` decorators
- `@nestjs/swagger` — `@ApiOperation()`, `@ApiResponse()`, etc.

## DTO template (request body)
```typescript
import { IsString, IsEmail, IsOptional, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Request DTO for creating a new user.
 * Validated automatically by NestJS ValidationPipe.
 */
export class CreateUserDto {
  @ApiProperty({ description: 'User email address', example: 'user@example.com' })
  @IsEmail({}, { message: 'email must be a valid email address' })
  email: string;

  @ApiProperty({ description: 'Display name', example: 'John Doe', minLength: 2 })
  @IsString()
  @MinLength(2)
  name: string;

  @ApiPropertyOptional({ description: 'Optional phone number' })
  @IsOptional()
  @IsString()
  phone?: string;
}
```

## Controller template
```typescript
import { Controller, Get, Post, Body, Param, ParseUUIDPipe, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { UsersService } from '../application/users.service';
import { CreateUserDto } from './dtos/create-user.dto';
import { UserResponseDto } from './dtos/user-response.dto';

/**
 * REST controller for user management.
 * All methods return DTOs — never raw database entities.
 */
@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  /**
   * Create a new user.
   *
   * @param dto - Validated request body.
   * @returns The created user's public profile.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new user' })
  @ApiResponse({ status: 201, description: 'User created', type: UserResponseDto })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 409, description: 'Email already in use' })
  async create(@Body() dto: CreateUserDto): Promise<UserResponseDto> {
    return this.usersService.create(dto);
  }

  /**
   * Find a user by UUID.
   *
   * @param id - The user's UUID.
   * @returns The user's public profile.
   */
  @Get(':id')
  @ApiOperation({ summary: 'Get user by ID' })
  @ApiParam({ name: 'id', description: 'User UUID' })
  @ApiResponse({ status: 200, type: UserResponseDto })
  @ApiResponse({ status: 404, description: 'User not found' })
  async findOne(@Param('id', ParseUUIDPipe) id: string): Promise<UserResponseDto> {
    return this.usersService.findById(id);
  }
}
```

## ValidationPipe — must be enabled globally in main.ts
```typescript
// src/main.ts
import { ValidationPipe } from '@nestjs/common';

app.useGlobalPipes(new ValidationPipe({
  whitelist: true,        // strips unknown fields
  forbidNonWhitelisted: true,  // throws on unknown fields
  transform: true,        // auto-transform types (string → number)
}));
```

## HTTP status code guide
| Scenario | Status code |
|---|---|
| Created resource | `201 CREATED` |
| Retrieved resource | `200 OK` |
| Resource not found | `404 NOT_FOUND` |
| Validation failed | `400 BAD_REQUEST` |
| Duplicate / conflict | `409 CONFLICT` |
| No content (delete) | `204 NO_CONTENT` |

## After creating the endpoint
1. `run_integrity_check()` — zero errors required
2. If Swagger decorators cause TS errors → check `@nestjs/swagger` is installed
3. Write a spec test for the new endpoint using the `write-tests` skill
