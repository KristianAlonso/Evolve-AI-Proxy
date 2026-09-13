# ADR A-008: Phase-prompt shaping — base + último mensaje intermedio + instrucción (user)

**Status:** accepted
**Fecha:** 2026-07-09

## Contexto

El proxy es un sistema agéntico iterativo (A-003) que hace varias llamadas upstream por petición
(`interpret → planify → execute → evaluate`, por ronda). Antes de este ADR, cada fase
construía su prompt de forma independiente y **acumulaba** el historial de fases intermedias
(`ContextManager`, compresión por tokens), lo que generaba prompts inconsistentes y crecientes:
la fase de interpretación recibía el objetivo completo reescrito, la fase de ejecución recibía
solo bullets sintéticos del contexto, y el evaluador recibía el objetivo + contexto acumulado.

El problema de fondo: **el contexto que el modelo ya conoce** (el objetivo, el estado de
acumulado) se re-inyectaba en texto libre generado por el proxy en cada fase, en lugar de
reconocerse como lo que es: la conversación del cliente + la última respuesta recibida.

### Regla solicitada

1. **La conversación que el usuario mandó al proxy se mantiene intacta**: el `system` message
   del cliente se conserva byte a byte como primer mensaje; el proxy **nunca añade mensajes
   `system`**.
2. **Toda instrucción nueva que añada el proxy se añade al final** como mensaje
   `user` (en la rama de `messages` que se envía upstream).
3. **Los mensajes intermedios generados/recibidos por la API NO se guardan**: del historial
   de fases anteriores solo se conserva **el último mensaje intermedio** (la salida cruda de
   la última fase, como un único turno `assistant`) y la instrucción final de la fase
   actual (`user`).

## Decisión

Toda llamada upstream de una fase del bucle (inline u orquestador) usa **una sola forma
canónica**, construida por `buildPhasePrompt` (`phase-prompts.ts`):

```
[
  ...baseCliente,                      // toInternalMessages | toRenderedMessages (sticky, 4xx)
  ...(lastMessage ? [
    { role: 'assistant', content: lastMessage },   // la SALIDA CRUDA de la última fase
  ] : []),
  { role: 'user', content: instruction },          // la instrucción de LA fase actual
]
```

donde:

- `baseCliente` es la conversación del cliente sin tocar (R1: roles preservados —
  `assistant`/`tool` viajan como vinieron; fallback *rendered* flat si upstream rechaza la
  forma estructurada, sticky vía `fellBackToRendered`).
- `lastMessage` es la última salida cruda de fase (`interp.raw`, `planify.raw`,
  `execute.content`, `evaluator.raw`), actualizada **después de cada fase**. Todo el
  historial de fases anterior se descarta — no se acumula, no se comprime.
- `instruction` es el texto de la fase actual, **siempre** en un mensaje `user` al final:
  - interpret: `INTERPRET_INSTRUCTION` (constante)
  - planify: `buildPlanifyInstruction(goalHint)` — sin re-inyectar el objetivo completo,
    la base del cliente ya lo contiene
  - execute: el `taskContent` de la ronda (sin el prefijo "You are the executor..." —
    la instrucción es el contenido de la tarea, que ya va como `user`)
  - evaluate: `buildEvaluateInstruction(originalInstruction)` — referencia "the assistant
    message immediately above" (la última salida intermedia) en lugar de un bloque
    separado de contexto

### Consecuencias

- **Simplificación fuerte**: se elimina `ContextManager` (y su compresión por tokens);
  se eliminan los builders ad hoc (`buildPlanifyPrompt`, `buildStructuredExecutePrompt`,
  `buildRenderedExecutePrompt`, `buildEvaluatePrompt`), `stepBullets`/`accumulatedSummary`
  en prompts (queda `accumulatedSummary` solo para el campo `accumulated_context` de la
  respuesta final) y el re-embolsado del objetivo completo en cada fase.
- **Consistencia inline/orquestador**: `AgentLoop` (inline) y `SubagentOrchestrator`
  (FASE 6, delegación a subagentes) comparten los mismos builders de instrucción y la misma
  forma canónica; el orquestador aplica el fallback sticky de forma estructurada→rendered
  a **todas** las fases delegadas (antes solo execute).
- **Estado mínimo serializable**: `LoopStateData` gana `lastMessage: string`,
  `fellBackToRendered: boolean` (sticky shape) y `context_window_size: number`
  (ver Refinimientos 1 y 3).
- **El mapper de subagentes** (`subagent-mapper.ts`) es una excepción deliberada: no es
  una fase del bucle — no lleva la conversación del cliente (es una meta-llama interna
  sobre las tools del cliente), así que sigue montando su propio prompt (system + user).

### Evidencia de verificación

- **Unit (94 tests)**: `phase-shaping.test.ts` verifica a nivel de prompt, con el stub
  in-memory (sin red) inspeccionando EXACTAMENTE los `messages` de cada llamada upstream:
  - el `system` del cliente es el primer mensaje, byte a byte, en TODA llamada; no hay
    jamás más de un `system`;
  - toda instrucción del proxy va en el último mensaje `user`;
  - ninguna fase lleva más de UN turno `assistant` intermedio, y ese turno es la salida
    cruda de la fase inmediatamente anterior (verificado en 1 y 2 rondas);
  - el orquestador (fase delegada) produce la misma forma canónica.
- **Live (litellm / `llama_cpp/default`, sin plugin)**: petición `Build X` con
  `stream:true` — `interpret(72.1s) → planify(55.9s) → execute(49s) → evaluate(48s)`,
  `decision=complete round=1 upstream_calls=4`, respuesta final devuelta al cliente.
- Los regex del stub (`/interpreter of an agent loop/`, `/planning the next concrete/`,
  `/Reply with EXACTLY one of/`) siguen satisfaciéndose: las instrucciones reescritas las
  conservan.

## Alternativas consideradas

- **Mantener el historial de fases y comprimirlo (`ContextManager`)**: se descarta — el
  contexto acumulado era texto sintético del proxy que el modelo ya había visto; la regla
  "solo el último mensaje" elimina la duplicación y la derivación del contexto.
- **Añadir la instrucción como `system`**: se descarta — la regla prohíbe que el proxy
  añada `system`; la instrucción de fase es `user` al final.

## Impacto

- **Positivo**: prompts de fase deterministas, pequeños y uniformes; menos estado que
  serializar; el modelo ve la conversación real del cliente + la última cosa que dijo, y
  no reconstrucciones del proxy.
- **Riesgo**: si una fase necesita contexto antiguo (varias rondas atrás), debe
  re-derivarse de la conversación del cliente + la última salida; mitiguado por el
  `goalHint` de planify (solo la primera ronda) y la referencia al original en evaluate.

## Refinimientos (post-implementación inicial)

1. **Compaction de contexto delegada al cliente (SC-021/SC-022)** — sustituye a la
   `fitToContextWindow` (reducción/condensado) implementada en la primera pasada: el proxy
   NUNCA trunca, corta ni condensa mensajes. En su lugar, la compaction la hace el
   **cliente** (p. ej. OpenCode) y el proxy actúa de detector + passthrough + reanudador:
   - **Detección**: tras cada llamada upstream de fase (interpret/planify/execute/evaluate,
     inline y delegada) se compara el `usage` REAL (`prompt_tokens`) contra
     `context_window_size × CONTEXT_COMPACT_THRESHOLD` (`contextFull()` en
     `phase-prompts.ts`; umbral por env, por defecto 0.9). `context_window_size = 0`
     (desconocida) = sin check: el upstream decide (SC-022) y el
     `ContextWindowExceeded` sigue siendo fail-fast (sin reintentos).
   - **Interrupción**: al alcanzar el umbral se rompe la secuencia sin más llamadas
     (`LoopDecision = 'context_compact_pending'`; en el orquestador, la bandera
     `state.compactPending` sobrevive el parent-resume). La fase interrumpida NO guarda
     resultado; en su lugar se emite `COMPACT_PENDING_NOTICE` como `final_output`.
   - **Pre-bloqueo**: mientras `compactPending` está puesto, cada nueva petición de fase
     se responde con el notice **sin llamada upstream** (evita el `ContextWindowExceeded`
     en el intento siguiente).
   - **Relevo de `usage`**: el `usage` real de la última llamada se incluye en el finish
     chunk SSE (nivel raíz del JSON, junto a `choices`) y en la respuesta JSON
     (`toOpenAICompletion`), para que el cliente haga su propio tracking de tokens por
     mensaje (OpenCode comprime cuando `input+output` del último mensaje ≥ ventana
     efectiva). Sin este relevo el tracking del cliente nunca vería el contexto crecer.
   - **Passthrough de compaction**: la petición de compaction del cliente (detectada por
     `isCompactionRequest()`: marcador de OpenCode/Stainless en el último mensaje `user`)
     pasa **intacta** al upstream — sin agent loop, sin orquestador, sin bookkeeping de
     fases; la respuesta (el resumen) vuelve igual. Se intercepta ANTES de la
     tri-partición de `routes.ts` (también la de un subagente, cuyo `x-session-id` lo
     haría encajar en la rama de subagente).
   - **Reanudación**: la siguiente petición (contexto compactado) refresca
     `state.internalMessages` desde el montón entrante — se descartan por completo los
     mensajes viejos —, limpia `compactPending`/`lastMessage`, descarta el notice
     pendiente y re-emite la fase interrumpida. Si el contexto sigue ≥ umbral se repite
     el ciclo con el mismo `agent_id` (spawn estable); si ya está bajo, `agent_id` nuevo.
     En el bucle inline (sin estado persistido) la reanudación es un `AgentLoop.run()`
     fresco: el interpret re-deriva el objetivo (degradación aceptable; OpenCode siempre
     usa el camino delegado, que tiene `tools`).
   - El estado de la compaction vive en `LoopStateData` (`compactPending`, `lastUsage`)
     para sobrevivir la serialización del parent-resume.
2. **Anuncio de fase en tiempo real** — antes de cada llamada upstream de fase, el cliente
   recibe un delta de razonamiento `[fase] <qué va a hacer>` (interpret/planify/execute/
   evaluate, tanto inline como delegadas; execute incluye la descripción de la tarea).
   El wire sigue siendo 100 % OpenAI (no se inventan tipos de evento).
3. **Flujo delegado: la salida de la fase la persiste el cliente** — el cliente ya guarda
   la salida de cada fase en su historial (resultado del tool call de spawn), por tanto:
   - `resume(state, sessionId, incomingMessages)` refresca `state.internalMessages` desde
     el montón entrante del padre y limpia `state.lastMessage` tras consumir un resultado:
     la salida de la fase NUNCA viaja en dos copias (no se añade un turno `assistant`
     extra por encima del tool result).
   - `lastMessage` solo viaja con el raw del interpret (la única salida de fase que NO
     está en el historial del padre).
   - El bucle inline (`AgentLoop`) conserva su `this.lastMessage` en memoria (no se
     serializa: un request inline es una sola llamada).
