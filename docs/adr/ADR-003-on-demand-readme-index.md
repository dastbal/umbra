# ADR-003: Indice local y bajo demanda de README

## Estado

Sustituida - 2026-08-07 por ADR-004. El usuario aclaro que el indice requerido
era de ADRs, no de README.

Complementa ADR-001 y ADR-002.

## Contexto

Los README contienen instrucciones utiles, pero leerlos todos en cada tarea
consume contexto sin ayudar a la mayoria de cambios de codigo. Inyectarlos en
el prompt o indexarlos con embeddings tambien aumenta tokens, costo y riesgo de
mezclar documentacion irrelevante con la tarea activa.

## Decision

1. Se agrega la herramienta `list_readmes`, disponible para el agente Deep y
   el Researcher.
2. La herramienta genera o reutiliza `.agent/readme-index.json` con solo ruta,
   titulo y hasta ocho encabezados por README.
3. El catalogo se reconstruye unicamente si cambio el tamano o la fecha de
   modificacion de un README, o si se solicita `refresh`.
4. El indice excluye `.agent`, `.git`, `node_modules`, artefactos de build y
   cobertura. Nunca devuelve el cuerpo de un README.
5. El prompt indica no explorar README durante tareas ordinarias. Para setup,
   uso, documentacion o una guia externa, primero usa `list_readmes` y luego
   `safe_read_file` solo sobre el documento elegido.
6. El modo `analyze` sigue sin herramientas y no recibe este catalogo: conserva
   el alcance determinista definido por ADR-002.

## Alternativas rechazadas

- Leer todos los README al inicio de cada sesion: eleva contexto y costo de
  tareas que no necesitan documentacion.
- Inyectar los README en el prompt base: vuelve permanente informacion que casi
  nunca es relevante.
- Agregar todos los README al RAG vectorial: requiere embeddings y recuperacion
  para una necesidad que se resuelve con metadatos locales pequenos.

## Validacion

Las pruebas verifican extraccion de titulo y encabezados, exclusion de
`node_modules`, ausencia de cuerpos de documento y reconstruccion al cambiar
un README.

En el proyecto se ejecuto `list_readmes` dos veces: la primera creo un catalogo
de dos README; la segunda reutilizo la cache. La respuesta devolvio solo rutas,
titulos y encabezados. `tsc --noEmit` y las pruebas relacionadas pasaron.

## Consecuencias

- Las tareas normales no cargan documentacion adicional.
- Las tareas documentales tienen una ruta de descubrimiento predecible y de
  bajo costo.
- La cache es estado local no versionado; si falta o se corrompe se reconstruye.
- Para detalles de un README el agente aun debe leer el archivo seleccionado;
  el indice no sustituye la fuente primaria.
