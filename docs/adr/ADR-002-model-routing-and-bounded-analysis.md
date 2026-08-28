# ADR-002: Enrutamiento por rol y analisis acotado por evidencia

## Estado

Aceptada - 2026-08-07

Complementa ADR-001.

## Contexto

El proyecto busca autonomia con costo controlado. El modelo global configurado en
`AGENT_MODEL=gemini-2.5-flash-lite` estaba reemplazando tambien el modelo de
los subagentes. Como consecuencia, el Coder no recibia el perfil
`gemini-2.5-pro` configurado para tareas de implementacion complejas.

La prueba de una auditoria amplia tambien revelo un conflicto de instrucciones:
el modo `analyze` incluia un manifiesto de evidencia acotado, pero a la vez su
prompt ordenaba descubrir skills y volver a leer archivos. Flash-Lite realizo
10 llamadas de herramientas, creo 32 checkpoints y alcanzo el limite de 30
turnos sin finalizar. Aumentar el limite solo habria ocultado el conflicto y
elevado el costo.

## Decisiones

1. La resolucion del modelo principal es:
   `--model` explicito > `AGENT_MODEL` > perfil del proyecto.
2. Los roles de un orquestador resuelven su perfil sin leer `AGENT_MODEL`:
   Supervisor, Researcher y Verifier usan Flash-Lite por defecto; Coder usa
   Pro por defecto.
3. `--model` permite elevar solo una sesion o auditoria sensible a calidad, sin
   editar el `.env` ni encarecer todos los roles.
4. El modo `analyze` es de una sola pasada y usa exclusivamente el manifiesto
   local con citas `ruta:linea`. No expone RAG, listados ni lecturas de archivos.
5. Si el manifiesto no demuestra un hecho, la salida debe declarar
   `No verificado`; no puede completar la respuesta con una suposicion.
6. Las investigaciones interactivas o profundas siguen usando `deep` u
   `orchestrate`, donde RAG y lecturas directas si estan disponibles.

## Evidencia de validacion

Se uso la misma solicitud de diez puntos (proposito, arquitectura, CLI,
sesiones, RAG, seguridad, contexto, costo, rendimiento y prioridades) contra
el repositorio.

| Ejecucion | Resultado observado |
| --- | --- |
| Flash-Lite antes de la correccion | No finalizo: limite de 30 turnos tras 10 llamadas de herramientas. |
| Flash-Lite con manifiesto acotado e indice listo | Finalizo en 16.3 s con diez hallazgos; calidad util, pero con inferencias mas generales. |
| Pro con manifiesto acotado | Finalizo en 68 s con diez hallazgos, citas con linea e inferencias mejor delimitadas. |

La latencia es una observacion de esta maquina, este proyecto y esta cuenta de
Vertex AI; no es un benchmark universal ni una medida de facturacion.

La correccion se verifico con `tsc --noEmit` y Jest: 9 suites y 37 pruebas
pasaron. Las pruebas cubren la prioridad de modelos, el aislamiento de perfiles
de rol y el protocolo de analisis sin herramientas.

## Consecuencias

- Las consultas de auditoria amplia son deterministas, economicas y no llenan
  contexto con transcripciones de herramientas.
- Flash-Lite es apropiado para reportes generales de bajo costo, pero Pro queda
  recomendado para arquitectura, decisiones complejas y resultados de mayor
  precision.
- `analyze` tiene alcance deliberadamente limitado al manifiesto; no debe usarse
  para una investigacion que requiera archivos fuera de esa evidencia.
- No se aumentara `maxAgentTurns` para resolver conflictos de prompt sin primero
  eliminar la causa del ciclo.
