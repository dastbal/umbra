---
name: security-audit
description: Security audit for NestJS code — detect secrets, validate inputs, check auth guards, prevent common vulnerabilities (OWASP Top 10 for APIs)
triggers: [security, audit, secret, vulnerability, injection, XSS, CSRF, auth, unauthorized, exposure, sensitive, password, token, key]
---

# Skill: Security Audit for NestJS APIs

> Source: OWASP API Security Top 10 + cursor.directory security section

## Scanning protocol — read before you report

```
ask_codebase("hardcoded secrets, passwords, API keys, tokens")
ask_codebase("input validation, class-validator, sanitization")
ask_codebase("authentication guards, JWT, authorization")
ask_codebase("SQL queries, raw query, query builder unsafe")
```

## OWASP API Top 10 — check each one

### 1. Broken Object Level Authorization (BOLA)
Users must only access their own resources.

```typescript
// ❌ Wrong: user can access any order by ID
@Get('orders/:id')
getOrder(@Param('id') id: string) {
  return this.ordersService.findById(id); // no ownership check!
}

// ✅ Correct: verify ownership
@Get('orders/:id')
@UseGuards(JwtAuthGuard)
getOrder(@Param('id') id: string, @CurrentUser() user: AuthUser) {
  return this.ordersService.findByIdAndOwner(id, user.id);
}
```

### 2. Broken Authentication
- [ ] JWT tokens have expiry (`expiresIn` set)
- [ ] Refresh tokens are rotated (single use)
- [ ] Passwords hashed with `bcrypt` (min 10 rounds), never stored plain
- [ ] Rate limiting on `/auth/login` and `/auth/refresh` (`@nestjs/throttler`)

### 3. Broken Object Property Level Exposure
- [ ] Response DTOs never include: `password`, `passwordHash`, `salt`, internal IDs
- [ ] `@Exclude()` on sensitive properties in class-transformer
- [ ] `ValidationPipe({ whitelist: true })` strips unknown fields

```typescript
// ❌ Wrong: returns everything including password
return user; // raw entity

// ✅ Correct: map to response DTO
return new UserResponseDto(user); // only public fields
```

### 4. Unrestricted Resource Consumption
- [ ] Pagination on all list endpoints (no unbounded queries)
- [ ] Rate limiting configured globally
- [ ] File upload size limits set
- [ ] Query depth limits for complex filters

### 5. Broken Function Level Authorization
- [ ] Admin-only endpoints have `@UseGuards(RolesGuard)`
- [ ] `@Roles(Role.ADMIN)` applied to sensitive operations
- [ ] No endpoint returns admin data without role check

### 6. Unrestricted Access to Sensitive Business Flows
- [ ] Price/discount fields not modifiable by user-facing endpoints
- [ ] Order status transitions validated server-side (not just client)

### 7. Server-Side Request Forgery (SSRF)
- [ ] URLs from user input are validated against an allowlist
- [ ] No direct HTTP calls to user-provided URLs without validation

### 8. Security Misconfiguration
- [ ] `CORS` configured with explicit origins (not `*` in production)
- [ ] No stack traces exposed in production error responses
- [ ] `helmet()` enabled in `main.ts`

```typescript
// main.ts — required security headers
import helmet from 'helmet';
app.use(helmet());
app.enableCors({ origin: process.env.ALLOWED_ORIGINS?.split(',') });
```

### 9. Improper Inventory Management
- [ ] No debug endpoints exposed in production (`/debug`, `/health/internal`)
- [ ] API versioning in place (`/api/v1/...`)

### 10. Unsafe Consumption of APIs
- [ ] External API responses validated before use
- [ ] Secrets from external services stored in environment variables only

## Hardcoded secrets scan

```
ask_codebase("password =", "secret =", "apiKey =", "token =", "key =")
```

If found hardcoded in source files → immediate flag. Must move to `process.env`.

## Audit report format

```markdown
## Security Audit Report

**Critical (fix immediately):**
- ❌ [file:line] — [description of vulnerability]

**High (fix before release):**
- ⚠️ [file:line] — [description]

**Medium (fix in next sprint):**
- 🔵 [file:line] — [description]

**Passed:**
- ✅ No hardcoded secrets found
- ✅ All list endpoints have pagination
- ✅ JWT expiry configured
```
