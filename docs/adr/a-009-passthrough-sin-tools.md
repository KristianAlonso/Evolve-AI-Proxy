# A-009: Passthrough de peticiones sin tools

**Estado:** Aceptada
**Fecha:** 2026-09-13

## Contexto

El cliente (OpenCode) envía peticiones auxiliares **sin `tools`** además del flujo principal.
La más relevante es la **generación de título de sesión** (`"You are a title generator..."`),
que viaja con el **mismo `x-session-id`** que la conversación principal.

Antes de esta decisión, cualquier petición que no encajaba en las ramas de la tri-partición
FASE 6 (subagente / parent-resume / nuevo padre con tools) caía en el **bucle agéntico
inline clásico**. Con una petición de título eso costaba:

1. **3–4 llamadas upstream** (interpret/execute/evaluate) durante ~4 minutos para generar
   un título, compitiendo por el slot de `llama-server` con el flujo real.
2. **Corrupción de estado de sesión**: al completar, el bucle inline ejecutaba
   `store.delete(sessionId)` sobre el **mismo id de sesión** del padre — borrando la
   `loopState` del orquestador que estaba en curso. El siguiente parent-resume no
   encontraba estado, re-ejecutaba un "orchestrator start" completo (nuevo interpret,
   nueva fase planify) y el flujo delegado **se reiniciaba desde cero**.
3. **Re-prefills completos en el upstream local**: cada reinicio disparaba otro
   prefill de decenas de miles de tokens (un solo re-interpret costó ~31K tokens =
   ~18 s de prefill en llama.cpp a ~1.770 tok/s).

## Decisión

**Toda petición sin `tools` (y que no sea compaction) se sirve como passthrough puro** —
mismo patrón que la rama de compaction (A-007): una única llamada upstream con los
`messages` del cliente intactos, respuesta SSE o JSON según el cliente, y **sin lectura
ni escritura alguna en el `SessionStore`** (no crea, no salva, no borra sesiones).

La rama se evalúa **antes** de la tri-partición de FASE 6 (env / loopState / nuevo
padre), precisamente para que una petición auxiliar comparta el id de sesión del padre
sin poder tocar su estado.

El bucle inline clásico queda reservado a: (a) peticiones **con** tools que fallen el
mapeo del orquestador (fail-safe FASE 6) y (b) delegación nativa FASE 2.

```
sin tools (≠ compaction) → passthrough (1 llamada, sin sesiones)
compaction               → passthrough (1 llamada, sin sesiones)
env (subagente)          → runSubagentPhase / continuation
loopState (resume)       → orchestrator.resume
nuevo padre (tools)      → orchestrator.start → (null → loop inline)
resto con tools          → loop inline (FASE 2 / fail-safe)
```

### Verificación

- Test: `src/test/no-tools-passthrough.test.ts` (1 llamada upstream, messages verbatim,
  `meta.passthrough`, la `loopState` de un padre con la misma sesión sobrevive).
- Verificado live: la petición de título de OpenCode dejó de lanzar el bucle agéntico
  (1 llamada, <2 s) y el flujo planify→execute→evaluate completó sin reinicio.

## Consecuencias

- El modo "chat de standalone sin tools con bucle agéntico" (variante A-003) queda
  desactivado de facto: sin tools no hay nada que ejecutar, y el bucle solo multiplicaba
  llamadas upstream. Los usuarios que necesiten el bucle deben enviar tools (o el
  fail-safe de mapeo lo activa igual).
- Las peticiones auxiliares del cliente (título, y futuros helpers similares) son
  baratas (1 upstream call) e **inocuas** para el estado del orquestador.
