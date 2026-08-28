# ADR-004: Indice local y bajo demanda de decisiones ADR

## Estado

Aceptada - 2026-08-07, enmendada 2026-08-28

Sustituye ADR-003, que documento un indice de README por una interpretacion
incorrecta de la solicitud original.

> **Amendment — 2026-08-28.** The index worked; the parser reading it did not,
> and the failure was silent.
>
> `extractSectionParagraph` in `src/core/tools/adr-index.ts` looked for the
> headings `## Estado` and `## Contexto`. Those are the headings of the first
> four records, written in Spanish. Every record from ADR-005 onward uses
> `## Status` and `## Context`, because the project convention is that anything
> written into the repository is in English.
>
> The result, measured on 2026-08-28 by running the built index over this
> directory: **16 of 20 records reported `Sin estado` and `Sin contexto`.**
> `list_adrs` returned their titles and nothing else. The agent is instructed by
> `buildSystemPrompt` to call this tool before consulting a prior decision, and
> for 80% of the decision history it was being handed a filename and a title
> with no status — so it could not tell an Accepted record from a Superseded one
> without opening the file, which is the exact context spend this record exists
> to avoid.
>
> Both spellings are now accepted (`STATUS_HEADINGS`, `CONTEXT_HEADINGS`), and
> `adr-index.spec.ts` covers an English record alongside a Spanish one so the
> next format shift fails a test instead of quietly degrading. Verified: 22 of
> 22 records now report a status.
>
> Nothing else in this record changes. The on-demand, cached, bounded-context
> design it decided is unaffected and still in force.

## Contexto

Los ADR contienen decisiones duraderas del agente, pero leer todos en cada
tarea llena el contexto y vuelve a introducir decisiones que no aplican. El
agente necesita descubrir de forma barata cual ADR trata de modelos, seguridad,
memoria, herramientas o arquitectura antes de abrir el documento completo.

## Decision

1. Se agrega `list_adrs`, disponible para el agente Deep y el Researcher.
2. La herramienta genera o reutiliza `.agent/adr-index.json` con identificador,
   ruta, titulo, estado y el primer parrafo acotado de Contexto.
3. El catalogo se reconstruye si cambia un ADR o si se solicita `refresh`.
4. El prompt prohíbe explorar ADRs por defecto. Solo para historia tecnica,
   decisiones de arquitectura, modelos o limites de seguridad debe llamar
   `list_adrs` y despues abrir un unico ADR seleccionado.
5. El modo `analyze` permanece sin herramientas, conforme a ADR-002.

## Alternativas rechazadas

- Leer todos los ADR al inicio de cada sesion: desperdicia contexto y tokens.
- Inyectar el historial de ADR en el prompt base: mezcla decisiones sin relacion
  con la tarea activa.
- Crear embeddings de cada ADR: requiere llamadas y recuperacion vectorial para
  una necesidad resuelta con metadatos locales pequenos.

## Validacion

Las pruebas verifican identificador, titulo, estado, contexto, exclusion de
archivos que no son ADR y reutilizacion de cache hasta que un ADR cambia.
En el proyecto se ejecuto `list_adrs` dos veces: la primera creo un catalogo de
cuatro ADR; la segunda reutilizo la cache sin devolver cuerpos de ADR.
`tsc --noEmit` y las pruebas relacionadas pasaron.

## Consecuencias

- Las tareas normales conservan el contexto limpio de historial arquitectonico.
- Las tareas que necesitan una decision pasada encuentran primero el ADR
  relevante y leen solo ese documento.
- La cache es estado local no versionado; si falta o se corrompe se reconstruye.
