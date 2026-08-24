import { classifyOrchestrationTask, formatOrchestrationRoute } from './task-classifier';

describe('classifyOrchestrationTask', () => {
  it('keeps a read-only question on the inexpensive direct route', () => {
    const route = classifyOrchestrationTask('Explain how the model resolver selects a provider.');

    expect(route.complexity).toBe('small');
    expect(route.requiresImplementation).toBe(false);
    expect(route.subagents).toEqual([]);
  });

  it('uses the complete quality gate for a feature implementation', () => {
    const route = classifyOrchestrationTask(
      'Create a UsersModule with a REST endpoint, DTOs, tests, and Prisma repository.',
    );

    expect(route.complexity).toBe('large');
    expect(route.requiresImplementation).toBe(true);
    expect(route.subagents).toEqual(['researcher', 'coder', 'verifier']);
  });

  it('uses the same safe write path for a focused bug fix', () => {
    const route = classifyOrchestrationTask('Fix the null guard in src/users/users.service.ts.');

    expect(route.complexity).toBe('medium');
    expect(route.subagents).toEqual(['researcher', 'coder', 'verifier']);
  });

  it('formats a trusted route directive without changing the user request', () => {
    const request = 'Add validation to the login DTO.';
    const directive = formatOrchestrationRoute(classifyOrchestrationTask(request), request);

    expect(directive).toContain('complexity=medium');
    expect(directive).toContain('researcher -> coder -> verifier');
    expect(directive).toContain(request);
  });

  it('keeps Spanish read-only questions on the direct route', () => {
    const route = classifyOrchestrationTask(
      'Explica cómo se elige el modelo del Coder en el orquestador.',
    );

    expect(route.complexity).toBe('small');
    expect(route.requiresImplementation).toBe(false);
  });

  it('keeps greetings on the direct route without planning or delegation', () => {
    const route = classifyOrchestrationTask('hey');

    expect(route.complexity).toBe('small');
    expect(route.requiresImplementation).toBe(false);
    expect(route.subagents).toEqual([]);
  });

  it('routes Spanish implementation work through the full quality gate', () => {
    const route = classifyOrchestrationTask(
      'Corrige el reintento vacío del modo interactivo y agrega pruebas Jest.',
    );

    expect(route.complexity).toBe('medium');
    expect(route.subagents).toEqual(['researcher', 'coder', 'verifier']);
  });
});
