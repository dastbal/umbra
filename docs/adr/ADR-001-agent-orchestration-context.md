# ADR-001: Orquestación adaptativa y contexto por artefactos

## Estado

Aceptada — 2026-08-07

## Contexto

El agente debe trabajar sobre proyectos NestJS/NextJS con calidad alta, costo controlado y autonomía. El problema principal es que delegar subagentes puede contaminar el contexto del Supervisor con conversaciones, código y herramientas que no son necesarios para la decisión final.

## Decisiones

1. Las tareas pequeñas usan un agente único.
2. Las tareas medianas y grandes usan un solo nivel de delegación:
   `Supervisor → Researcher / Coder / Verifier`.
3. Researcher es de solo lectura.
4. Coder es el único escritor de código por tarea.
5. Verifier ejecuta pruebas, type-check y revisión del diff sin escribir código.
6. Los subagentes se comunican mediante artefactos estructurados y compactos, no mediante historiales completos.
7. Cada agente puede usar un modelo distinto mediante perfiles declarativos por rol.
8. El proyecto permite como máximo dos ciclos automáticos de corrección.
9. El estado operativo vive en `.agent/` por proyecto; las decisiones duraderas viven en ADRs versionados.
10. Los cambios seguros pueden ejecutarse automáticamente; borrados, secretos, infraestructura, Git push y despliegues requieren aprobación.
11. Las revisiones de arquitectura usan un modo `analyze` separado, de solo lectura, con un manifiesto acotado de evidencia del workspace y hallazgos estructurados con citas. Las auditorías amplias no lanzan consultas RAG semánticas en paralelo.

## Consecuencias

- El Supervisor conserva un contexto pequeño y auditable.
- Se reduce el costo de usar modelos potentes en tareas simples.
- La escritura serial evita conflictos entre agentes.
- Se necesita validar los artefactos de handoff y medir tokens, latencia y reintentos.
- El análisis basado en evidencia sacrifica algo de alcance RAG a cambio de latencia determinista y estabilidad del proveedor en auditorías amplias.
- Worktrees y escritura paralela quedan fuera de esta primera etapa.

---

## Amendment — 2026-09-21: decision 6 had one unrecorded exception

Decision 6 — *los subagentes se comunican mediante artefactos estructurados y
compactos* — described two of the three roles. The Researcher and the Verifier
carried a `responseFormat`; the Coder did not, and returned prose.

That was not a harmless gap. `readArtifactStatus` in
`src/core/agent/orchestration-guard.middleware.ts` recovers a delegation status
by searching the result text for a literal `"status": "..."`, so a successful
Coder produced none, was classified as an infrastructure failure, and left
`coderCalls` at zero — which made `src/core/agent/orchestration-policy.ts` refuse
the Verifier and throw. The full chain is in the 2026-09-21 amendment to
`ADR-023-interlocking-triage-readback-and-balanced-books.md`.

`implementationArtifactSchema` in `src/core/agent/contracts.ts` is now bound to
the Coder profile in `src/core/subagents/coder.subagent.ts`, so decision 6
describes all three roles rather than the two that happened to comply.
