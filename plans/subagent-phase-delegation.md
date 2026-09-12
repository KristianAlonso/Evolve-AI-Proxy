# FASE 6 — Orquestación por subagentes delegados + roles de asistente nativos + visibilidad total

## Objetivo

Tres requisitos:

- **R1**: Los mensajes de asistente viajan al modelo como `assistant` (no aplanados a `system`/`user`). Aplica a los prompts internos del proxy.
- **R2**: Todo el trabajo del sistema se refleja en el cliente en todo momento (dentro de la restricción del wire: solo frames `chat.completion.chunk` válidos de OpenAI).
- **R3**: Al inicio de la primera petición (con tools) el proxy le pregunta al modelo **cuál herramienta crea subagentes** y **cómo mapear sus argumentos** (`title`, `type`, `prompt`) a una clase (`SubagentSpawnSpec`). A partir de la fase 2, cada fase se ejecuta **dentro de un subagente**: el proxy emite la llamada a la herramienta, el stream se cierra (desconexión), el cliente abre el subagente automáticamente y reenvía una petición **desde el subagente** que el proxy detecta por un **envelope** en el primer mensaje.

## Wire protocol (secuencia con el cliente)

```text
REQ 1 (padre S1, tools, x-session-id: S1)
  proxy:  (0) mapping call   → SubagentSpawnSpec (herramienta + arg_mapping + phase_types)
          (1) interpret      → única fase que corre en el padre; razonamiento como thinking
          (2) tool_call spawn(title="planify (round 1)", type=<spec>, prompt=<envelope+tarea>)
          → finish_reason: tool_calls → [DONE]

REQ 2 (subagente, prompt = envelope + tarea)
  proxy:  detecta envelope { phase, parent_session_id, agent_id }
          ejecuta planify; razonamiento como thinking, SALIDA DE LA FASE como content
          → finish_reason: stop → [DONE]
  (el cliente reporta la respuesta del subagente al padre y resume S1)

REQ 3 (padre S1 resume)
  proxy:  consume phaseResults[agent_id] → emite spawn(title="execute (round 1)")
          → tool_calls → [DONE]
REQ 4 (subagente execute)   → ejecuta execute → content
REQ 5 (padre resume)        → spawn(title="evaluate (round 1)") → tool_calls
REQ 6 (subagente evaluate)  → ejecuta evaluate → content
REQ 7 (padre resume)        → complete? → respuesta final como content, finish stop
                              continue? → siguiente ronda (spawn planify round 2)
```

## Envelope (detección del subagente)

El prompt de la spawn tool es SIEMPRE:

```text
{"phase":"planify","parent_session_id":"S1","agent_id":"agent-x3"}
<línea en blanco>
<descripción de la tarea actual>
```

- `agent_id` lo genera el proxy **antes** de emitir la ToolCall y **SÓLO viaja en el prompt** (envelope). NUNCA en los argumentos de la ToolCall (requisito explícito).
- `parseSubagentEnvelope(messages)` escanea los mensajes buscando la primera línea JSON con los 3 campos. El `agent_id` del prompt es la única fuente de verdad para vincular la petición a su fase.
- El título de la spawn tool = nombre de la fase (incluye la ronda); el `type` lo determinó el modelo en el mapeo (`phase_types[phase]`).

## Nuevos módulos (`app/src/core/`)

### `subagent-spawn.ts`

- `SpawnEnvelope { phase, parent_session_id, agent_id }`
- `SubagentSpawnSpec` (la clase de forma de herramienta): `{ toolName, argMapping: {title,type,prompt}, phaseTypes: Record<phase, typeId> }` — **sin agentId**.
- `buildSpawnPrompt(envelope, task)` / `parseSubagentEnvelope(messages)` / `newAgentId()` / `buildSpawnToolCall(spec, envelope, task, title?)` (args solo por `argMapping`; `agent_id` jamás en args).

### `subagent-mapper.ts`

- `mapSubagentTool(provider, model, tools, opts): Promise<SubagentSpawnSpec | null>`
- 1 llamada upstream (2 intentos si el JSON no parsea). Prompt: "identifica la tool que crea subagentes y mapea sus args. Responde SOLO JSON `{tool_name, arg_mapping:{title,type,prompt}, phase_types:{planify,execute,evaluate}}`".
- Fail-safe (nunca rompe la petición): sin tools → `null` (sin llamada); tool desconocida o JSON inválido → `null` + WARN. `null` ⇒ rutas caen al flujo inline actual (backwards compat FASE 2).

### `loop-state.ts`

- `LoopStateData` serializable (vive en `SessionStore`): `stage ('planify'|'execute'|'evaluate'|'done')`, `round`, `max_rounds`, `originalInstruction`, `internalMessages`, `interpretation`, `task`, `lastOutput`, `accumulatedSteps`, `spec`, `pendingAgentId`, `phaseResults (agent_id→content)`, `decision`, `finalOutput`, `totalUpstreamCalls`.

### `orchestrator.ts`

- `SubagentOrchestrator`:
  - `start(...)`: mapping + interpret (en el padre, razonamiento al cliente) + `spawn(planify)`. Devuelve `null` si `spec === null` (fallback).
  - `resume(...)`: consume `phaseResults[pendingAgentId]` según `stage` → siguiente `spawn` o resultado final (`complete` / `max_rounds_exceeded`).
  - `runSubagentPhase(...)`: ejecuta UNA fase (planify/execute/evaluate) con streaming; guarda `phaseResults[agent_id] = última content`.
- Prompts reutilizan los mismos textos de `agent-loop.ts` (compat con stubs/roUTERS existentes): planify "planning the next concrete…", execute goal+progress+task, evaluate `buildEvaluatePrompt`.

### Cambios en `agent-loop.ts` (R1)

- `toInternalMessages()`: deja de aplastar — `assistant`(+`tool_calls`) y `tool` conservan sus roles.
- `buildContextPrompt()`: outputs previos de execute como turnos `assistant`, cerrados con un turno `user` (nunca cerrar historial en `assistant`).
- Fallback: si el upstream rechaza el historial estructurado (error de forma 4xx), reintento UNA vez con la versión renderizada (comportamiento anterior) y memoizo la decisión para el resto del run.

### Cambios en `session-store.ts`

- `ToolDelegateSession` += `loopState?: LoopStateData`, `subagentBindings?: Record<subagentSessionId, {parentSessionId, agentId, phase}>`.

### Cambios en `routes.ts`

Tri-partición en `POST /v1/chat/completions` (antes del flujo actual):

| Detección | Condición | Acción |
| --- | --- | --- |
| Subagente | envelope en `messages`, o `x-session-id` con binding guardado, y la sesión padre existe con `loopState` | `runSubagentPhase` → streaming `content` + `stop` |
| Padre | `x-session-id` con `loopState` (stage done → final; si no → `resume`) | siguiente spawn o respuesta final |
| Nuevo con tools | `tools` + `x-session-id` | `orchestrator.start()` → interpret + spawn; `null` ⇒ fallback inline actual |
| Resto | — | comportamiento actual (inline) |

Wire 100% `chat.completion.chunk` (reasoning/thinking + content + tool_calls + finish). `R2`: transiciones de fase como deltas de `reasoning` cortos; el `content` sigue siendo solo la respuesta real.

## Tests

- `subagent-spawn.test.ts`: prompt (linea 1 JSON + linea 2 vacía + tarea), parse del envelope (happy/negativo/escaneo), `agent_id` jamás en args.
- `subagent-mapper.test.ts`: spec correcta con stub; sin tools → null sin llamadas; JSON malo/tool desconocida → null.
- `subagent-orchestrator.test.ts`: ciclo completo padre→planify→execute→evaluate→final; max_rounds; fail-safe a inline.
- Suite existente (58 unit + 7 live) sin regresiones. `tsc --noEmit` limpio.

## Docs

- ADR `docs/adr/A-006-subagent-phase-delegation.md` + actualización de `AGENTS.md`.

## Limitaciones documentadas

- El subagente puede hacer varios turnos internos; el resultado canónico de la fase es su **última** `content` (binding por `x-session-id` del subagente).
- Mapeo con fail-safe: sin tool de spawn real → degradación al flujo inline actual (logueado).

## Estado — COMPLETADO (2026-09-12)

### Entregado

- **Módulos**: `subagent-spawn.ts`, `subagent-mapper.ts`, `loop-state.ts`, `phase-prompts.ts`, `orchestrator.ts` — todos creados y compilando con `tsc --noEmit` limpio.
- **`routes.ts`**: tri-partición (subagent → parent resume → new-orchestrator → inline fallback) + helpers `handleSubagentPhase()`, `recordSubagentResult()`, `toFinalResult()`.
- **`agent-loop.ts` (R1)**: `toInternalMessages` (passthrough de roles) + fallback *rendered* ante rechazo 4xx (sticky); prompts de fase movidos a `phase-prompts.ts` compartidos.
- **`session-store.ts`**: `loopState?` + `subagentBindings?` en la sesión del padre.
- **Tests**: `src/test/subagent-delegation.test.ts` — 19 tests (spawn contract, mapper, orquestador: start/resume/runSubagentPhase + endurecimiento + failover + drift). Suite total: **89/89** (13 archivos) sin regresiones. `tsc --noEmit` limpio.
- **Docs**: ADR `docs/adr/a-006-subagent-phase-delegation.md` + índice; sección FASE 6 en `AGENTS.md`.

### Desviaciones del plan (todas justificadas)

1. **Tests integrados** en un único archivo `subagent-delegation.test.ts` (las tres specs del plan comparten fakes).
2. **Mapper**: `max_tokens` 512 → **8192** (los modelos de razonamiento gastan el presupuesto en thinking; con 512 salía `finish_reason:"length"` con `content:null`) y tools en **formato compacto** (218 tools JSON = 361 KB → ~30 KB), conservando los enums (críticos para resolver `phase_types`).
3. **Endurecimiento post-live**: `resume()` con resultado de fase ausente **re-emite el mismo spawn** (mismo `agent_id`) sin consumir el estado — descubierto en el run live #2 donde el plugin cliente bloqueaba los dispatches y el bucle giraba 8 rondas con salidas vacías. Verificado en el run live #3 (ronda estable en 1).

### Evidencia live (opencode + opencode-swarm, 218 tools, `llama_cpp/default`)

- Run #2: mapeo exitoso en el 1.º intento `tool="task" phase_types={planify:explorer,execute:coder,evaluate:reviewer}`; spawn de `planify (round 1)`; ciclos resume de ~10 ms / 3 frames hasta round 8 (giraba sin resultados — antes del endurecimiento); abort por disconnect limpio.
- Run #3 (post-endurecimiento): mismo mapeo; spawns estables de `planify (round 1)` re-emitiendo el mismo `agent_id` sin avanzar rondas; el cliente mostró los subagentes (`planify (round 5) — Explorer Agent`); abort propagation intacto.
- Run #4 (prompt de mapeo con preferencia general-purpose): mapeo `phase_types={planify:task,execute:task,evaluate:task}` — subagente general `Task Agent` en el cliente, no especializados. El plugin seguía bloqueando el dispatch (`KNOWLEDGE_ENFORCE_GATE_DENY`); el endurecimiento mantuvo la ronda en 1.
- Run #5 (un solo tipo + failover): mapeo `tool="task" type="default" available=[default]` (un único tipo validado como existente + lista de candidatos para failover). El cliente (opencode-swarm) **acepta** el tipo (muestra **Default Agent**). Con un solo tipo mapeado no hay rotación (re-emisión estable `retries=N/3`); la rotación de tipo (`SPAWN_RETRY_THRESHOLD=3` → siguiente tipo con `agent_id` nuevo, pinned al funcionar) está cubierta por tests unitarios del orquestador. *(Nota 2026-09-12: el failover es ahora **inmediato** — cada fallo rota de inmediato al siguiente tipo (round-robin) si hay más de uno; la variable `SPAWN_RETRY_THRESHOLD` quedó eliminada. Ver ADR A-006.)*
- **Limitación de entorno (no del proxy)**: el plugin `opencode-swarm` intercepta la herramienta `task` con contratos propios (campo `ACCEPTANCE:`, knowledge-gate) y reescribe el prompt del subagente (se pierde el envelope), así que el happy path completo de subagentes no puede completarse con ese plugin. El contrato del proxy (wire, mapeo, spawn, resume, re-emisión, abort) quedó verificado.

### Run #10–#11 — Causa raíz del `default` type y happy path completo (2026-09-12)

**Run #10 (`--pure`, sin plugins, 89 tools):** mapeo `tool="task" type="default" available=[default]` → el cliente rechaza en runtime: `Unknown agent type: default is not a valid agent type`. **Causa raíz:** con `--pure` la herramienta integrada `task` de opencode expone `subagent_type` **free-form** (sin enum) y lista los 9 types válidos (architect, coder, critic, designer, docs, explorer, reviewer, sme, test_engineer) al **final** de la descripción de la herramienta. El formato compacto del mapeador truncaba descripciones a 300 chars → el modelo nunca veía la lista → caía en el fallback `default` del prompt → el cliente lo rechazaba → el subagente nunca corría → re-emisión estable sin producto (fail-safe correcto, pero improductivo).

**Fixes (verificados en run #11):**
1. `subagent-mapper.ts`: herramientas **spawn-like** (nombre matchea `/task|spawn|subagent|agent|delegate|worker|launch/i`) conservan la descripción completa (cap 4000 chars) para que la lista de types sea visible; el resto sigue en 300. Test unitario cubre ambos casos.
2. `routes.ts`: `bodyLimit` Fastify 1 MB → **16 MB** (clientes gordinflones con 89–218 tool schemas enviaban cuerpos de ~1 MB → 413 intermitentes `Request body is too large`).

**Run #11 (happy path completo, `--pure`, 89 tools, `llama_cpp/default`):** mapeo `tool="task" type="sme" available=[sme,architect,explorer,coder,designer,docs,reviewer,critic,test_engineer]` — los 9 types reales enumerados y uno válido elegido. El cliente **ejecuta de verdad** los subagentes: `planify (round 1) ✓` → `execute (round 1) ✓` → `evaluate (round 1) ✓` (cada fase ~48 s de LLM real a través del proxy) → `orchestrator done: decision=complete round=1 upstream_calls=5` → respuesta final devuelta a opencode. **El happy path FASE 6 quedó verificado end-to-end con cliente real.**

### Pendiente (baja prioridad)

- ~~Bug de `readTraceId()`~~ **resuelto**: ahora es request-scoped.
- ~~(Opcional) Happy path completo sin `opencode-swarm`~~ **resuelto** en el run #11.
- (Opcional) Con el plugin swarm el happy path sigue bloqueado en el knowledge-gate del plugin (limitación de entorno, no del proxy).

## FASE 6.5 — Detección de drift de la lista de tipos (2026-09-12)

**Problema:** el cliente puede cambiar la lista de tipos de subagente entre peticiones (o renombrar la herramienta de spawn). El failover solo rota *dentro* de la lista mapeada; si el cliente renueva la lista, los tipos mapeados dejan de existir.

**Implementación:**

- `detectTypeDrift(spec, currentTools)` en `subagent-spawn.ts` — **determinista, sin el modelo**: drift = la herramienta de spawn ya no existe en `tools`, o el argumento `type` tiene un `enum` real donde **ninguno** de los ids de `spec.availableTypes` aparece. Sin `enum` (free-form) → no detectable sin el modelo → **no** se re-mapea (restricción: no preguntar al modelo para detectar).
- En la rama de **parent-resume** de `routes.ts` (nunca durante una fase subagente: esas peticiones entran por la rama de envelope): si `detectTypeDrift` → `await mapSubagentTool(...)` → en éxito, actualiza `loopState.spec`/`activeTypeId` y resetea `spawnRetries`; en fallo, conserva el spec anterior (log warning).
- `makeSink` en la rama de start ahora solo se ejecuta para `body.stream` (bug: el `SseWriter` con side effects corruptaba la respuesta JSON no-streaming).

**Verificación:** 4 tests unitarios de `detectTypeDrift` + 1 test de re-mapeo (spawn con el nuevo tipo). **Live (HTTP directo):** start con `enum=[plan,build]` → mapeo `type="build"` → spawn `type=build`; resume con el mismo enum → **sin** re-mapeo (0.0 s, sin upstream); resume con `enum=[fresh,new]` → `WARN subagent type list drifted (previous type="build" no longer exists) — remapped type="new"` → spawn `type=new`.

**Docs:** ADR (sección de drift + riesgo + evidencia #5) y `AGENTS.md` actualizados.

## Follow-up: ADR A-007 — Passthrough-intacto (2026-09-12)

**Cambio:** el proxy reenvía al upstream la petición del cliente **verbatim** (solo `messages` y `model` se transforman). Se eliminaron los `max_tokens` forzados (8192 mapper / 512 interpreter / 128 evaluator): lo que el cliente no envió, el proxy no lo inventa.

**Implementación:** `buildPassthrough(body)` en `routes.ts` (cosecha todo salvo `RESERVED_BODY_KEYS`) → `passthrough: Record<string, unknown>` viaja por todo el pipeline → `buildForwardOptions()` en `openai-compatible-provider.ts` (campos estándar → opciones v4; `reasoning_effort` → `reasoning` custom-string; resto → `providerOptions[PROVIDER_NAME='evolve_upstream']` = spread verbatim del SDK).

**Verificación:** 13 tests unitarios nuevos (fake SDK client) + wire-test con dump upstream (`tmp-oc/dump-upstream.ts`): 16 campos client → todos verbatim en el body upstream. Live contra LiteLLM: `temperature/top_p/seed/max_tokens/user/metadata` presentes en las 3 llamadas del bucle. Suite 93/93.

**Docs:** [`docs/adr/a-007-passthrough-intacto.md`](../docs/adr/a-007-passthrough-intacto.md) + índice ADRs.
