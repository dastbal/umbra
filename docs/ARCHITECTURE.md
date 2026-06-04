# 🏗️ Arquitectura: nestjs-ai-agent-lib

> Documento vivo — se actualiza con cada fase completada.
> Lee esto para entender QUÉ hay, POR QUÉ existe, y a DÓNDE vamos.

---

## Visión General

Esta librería implementa un sistema de agentes IA autónomos para proyectos NestJS.
El agente puede analizar un codebase, planear tareas, escribir código con tests,
y auto-corregirse — todo siguiendo DDD y TDD.

---

## Evolución del Sistema (Bitácora)

### 🏛️ Era 1: Agente Clásico ReAct (archivo: `factory.ts`)
**Cuándo:** versión inicial
**Qué es:** Un agente `createReactAgent` de LangChain — el patrón más básico.
**Cómo funciona:**
```
Usuario → LLM → decide qué tool llamar → ejecuta tool → LLM → decide → ...
```
**Problema:** Sin planificación, sin contexto comprimido, sin HITL. Un loop básico.

---

### 🏛️ Era 2: Multi-Agent Graph (archivo: `graph-factory.ts`)
**Cuándo:** versión 1.2.0 pre-deep
**Qué es:** Un `StateGraph` de LangGraph con 3 nodos explícitos:
```
Supervisor → (routing) → Researcher → devuelve → Supervisor
                     → (routing) → Coder → devuelve → Supervisor
                     → FINISH
```
**Por qué fue un avance:**
- Roles separados: Researcher solo lee, Coder solo escribe
- El Supervisor tiene structured output para decidir a quién delegar

**Problema:** Todo el orquestamiento es código manual. Sin `write_todos`,
sin context compression, sin HITL nativo. Mucho boilerplate.

---

### ⭐ Era 3: Deep Agent (archivo: `deep-agent-factory.ts`) — ACTIVO HOY
**Cuándo:** 2026-06-04, commit `a62aadc`
**Qué es:** Un agente construido con `createDeepAgent` de la librería `deepagents`.

**Por qué `createDeepAgent` es mejor:**
```
createReactAgent (LangChain base)
  +  FilesystemMiddleware → write_file, read_file, edit_file
  +  PlanningMiddleware   → write_todos, read_todos, update_todo
  +  SubAgentMiddleware   → task (lanzar subagentes)
  +  SummarizationMiddleware → context compression automática
  = createDeepAgent
```
Es decir: `createDeepAgent` = `createReactAgent` + superpoderes automáticos.

**Tools disponibles en Deep Agent:**

| Tool | Fuente | Para qué |
|---|---|---|
| `write_todos` | deepagents built-in | Crear plan antes de actuar |
| `read_todos` | deepagents built-in | Releer el plan si se pierde |
| `update_todo` | deepagents built-in | Marcar pasos completados |
| `task` | deepagents built-in | Lanzar subagente especializado |
| `ask_human` | deepagents built-in | Pedir ayuda al humano (HITL) |
| `read_file` | deepagents built-in | Leer archivo del disco |
| `write_file` | deepagents built-in | Escribir archivo del disco |
| `edit_file` | deepagents built-in | Editar fragmentos de archivo |
| `ls` | deepagents built-in | Listar directorio |
| `safe_write_file` | nuestro (SafeFilesystemBackend) | Escribir con backup automático |
| `safe_read_file` | nuestro (SafeFilesystemBackend) | Leer con validación |
| `list_files` | nuestro | Listar con filtros |
| `ask_codebase` | nuestro (RAG) | Búsqueda semántica en el código |
| `refresh_project_index` | nuestro (RAG) | Reindexar después de escribir |
| `run_integrity_check` | nuestro | Ejecutar `tsc --noEmit` + lint |
| `run_tests` | nuestro | Ejecutar Jest |

**Problema resuelto — Bug Gemini:**
`deepagents` v1.10.x incluye un tool `grep` con schema Zod que usa union types.
Gemini no soporta union types en function calling. Solución:
```typescript
registerHarnessProfile('gemini-2.5-flash-lite', {
  excludedTools: ['grep', 'glob']
});
```
El harness profile es el mecanismo de deepagents para personalizar el set de tools
por modelo. La clave debe ser el string exacto del modelo (no 'google' ni 'gemini').

---

## Arquitectura Target (Lo que estamos construyendo)

```
┌─────────────────────────────────────────────────────────────────┐
│                    CLI / API (Presentación)                      │
│  npm run agent -- deep "tarea"  |  POST /agent/stream (SSE)     │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│                      ORCHESTRATOR                                │
│              DeepAgent (createDeepAgent)                        │
│         model: AGENT_MODEL (env configurable)                   │
│                                                                  │
│  Protocolo mandatorio:                                          │
│  1. write_todos → crear plan                                    │
│  2. task(researcher) → analizar                                 │
│  3. task(coder) → implementar                                   │
│  4. run_integrity_check → verificar                             │
└──────────┬───────────────────────────────┬──────────────────────┘
           │ tool: task()                  │ tool: task()
           ▼                               ▼
┌──────────────────────┐   ┌──────────────────────────────────────┐
│   RESEARCHER         │   │   CODER                              │
│   SubAgent           │   │   SubAgent                           │
│   (DeepAgent)        │   │   (DeepAgent)                        │
│                      │   │                                      │
│  Solo LEE:           │   │  Solo ESCRIBE:                       │
│  - ask_codebase      │   │  - safe_write_file (con backup)      │
│  - safe_read_file    │   │  - safe_read_file                    │
│  - list_files        │   │  - run_tests                         │
│  - write_todos       │   │  - run_integrity_check               │
│                      │   │  - write_todos                       │
│  Devuelve: análisis  │   │  Devuelve: código implementado       │
│  + plan detallado    │   │  + resultado de tests                │
└──────────────────────┘   └──────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────────────────────┐
│                    INFRAESTRUCTURA                               │
│  SafeFilesystemBackend → backup antes de cada write             │
│  SqliteSaver → persistencia de conversación                     │
│  IndexerService (RAG) → embeddings del codebase                 │
│  ModelResolver → AGENT_MODEL env → LangChain LLM instance      │
└─────────────────────────────────────────────────────────────────┘
```

---

## Roadmap de Fases

### ✅ Fase 0 — Deep Agent Base
Commit: `a62aadc` | `DeepAgentFactory` con `createDeepAgent` funcionando.

### ⏳ Fase 1 — LLM Switch Configurable
**Qué:** Variable `AGENT_MODEL` controla qué LLM usa el agente.
**Por qué:** Gemini lite para tareas rápidas, Gemini pro para arquitectura,
Ollama para desarrollo offline sin gastar créditos.
**Archivo nuevo:** `src/core/config/model-resolver.ts`

```bash
AGENT_MODEL=gemini-2.5-flash-lite   # default, rápido y barato
AGENT_MODEL=gemini-2.5-pro          # para tareas de arquitectura
AGENT_MODEL=ollama:llama3.2         # local, sin internet, gratis
AGENT_MODEL=anthropic:claude-opus-4-7  # máxima calidad de código
```

### ⏳ Fase 2 — Researcher SubAgent
**Qué:** SubAgent especializado SOLO en leer y analizar.
**Por qué:** Separación de responsabilidades. El que analiza no escribe.
Reduce errores de "implementación prematura antes de entender el codebase".
**Archivo nuevo:** `src/core/subagents/researcher.subagent.ts`

### ⏳ Fase 3 — Coder SubAgent
**Qué:** SubAgent especializado en TDD — escribe spec ANTES que implementación.
**Por qué:** El que implementa no distrae con análisis. Foco = calidad de código.
**Archivo nuevo:** `src/core/subagents/coder.subagent.ts`

### ⏳ Fase 4 — Orchestrator
**Qué:** Agente principal que coordina Researcher + Coder via `task` tool.
**Por qué:** Reemplaza el viejo `StateGraph` manual con un flujo más inteligente.
**Modificación:** `DeepAgentFactory.createOrchestrator(config)`

### ⏳ Fase 5 — Context Compression
**Qué:** `createSummarizationMiddleware` de deepagents.
**Por qué:** En tareas largas (refactor de módulo completo), el contexto puede
llenarse. La compresión resume mensajes viejos automáticamente.

### ⏳ Fase 6 — Event Streaming SSE
**Qué:** `POST /agent/stream` en NestJS que devuelve `text/event-stream`.
**Por qué:** Permite integrar el agente en una app web o dashboard
con progreso en tiempo real.

### ⏳ Fase 7 — Skills System
**Qué:** Empaquetar estrategias del agente como `SKILL.md` reutilizables.
**Por qué:** Distribuir y reutilizar "cómo hacer DDD en NestJS" entre proyectos.

---

## Conceptos Clave para Aprender

### ¿Qué es un SubAgent?
Un SubAgent es un agente que corre DENTRO de otro agente, invocado por el tool `task`.
Es como un empleado especializado que tu agente principal puede contratar para tareas específicas.

```
Orchestrator (el jefe):
  "Necesito analizar el codebase" → task(researcher) → espera resultado
  "Necesito implementar X"        → task(coder)      → espera resultado
```

### ¿Qué es el Harness Profile?
Es el sistema de deepagents para personalizar el comportamiento del agente
por modelo de LLM. Puedes:
- Excluir tools incompatibles (`excludedTools`)
- Añadir instrucciones al system prompt (`systemPromptSuffix`)
- Sobrescribir descripciones de tools (`toolDescriptionOverrides`)

### ¿Qué es Context Compression?
Cuando el agente trabaja en tareas largas, el historial de mensajes crece.
La compresión toma los mensajes más viejos y los resume en un bloque compacto,
liberando tokens para continuar trabajando sin perder el contexto general.

### ¿Qué es SafeFilesystemBackend?
Un wrapper sobre las operaciones de filesystem que hace backup automático
antes de cada escritura. Si el agente escribe código malo, puedes restaurar.
Vive en `src/core/agent/safe-backend.ts`.

---

## Estructura de Carpetas (Target)

```
src/
├── bin/
│   └── cli.ts                    # Comandos: deep, orchestrate, classic
├── core/
│   ├── agent/
│   │   ├── factory.ts            # 🏛️ legacy ReAct
│   │   ├── graph-factory.ts      # 🏛️ legacy StateGraph
│   │   ├── deep-agent-factory.ts # ⭐ activo — createDeepAgent
│   │   └── safe-backend.ts       # backup engine
│   ├── config/
│   │   └── model-resolver.ts     # ⏳ Fase 1 — LLM switch
│   ├── subagents/
│   │   ├── researcher.subagent.ts  # ⏳ Fase 2
│   │   └── coder.subagent.ts       # ⏳ Fase 3
│   ├── rag/
│   │   └── indexer.ts
│   ├── tools/
│   │   └── index.ts
│   └── interaction/
│       └── index.ts
├── presentation/                 # ⏳ Fase 6 — SSE API
│   ├── agent.controller.ts
│   ├── agent.module.ts
│   └── dtos/
└── skills/                       # ⏳ Fase 7
    ├── nestjs-ddd-researcher/
    └── nestjs-tdd-coder/
```
