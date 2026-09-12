# A-006: Delegación de Fases a Subagentes (Subagent Phase Delegation)

**Estado:** Aceptada
**Fecha:** 2026-09-12
**Decisor(es):** Equipo evolve_ai_proxy

## Contexto

El bucle agéntico (A-003) corre íntegro **dentro** de una sola petición HTTP: interpretar → planificar → ejecutar → evaluar dentro del mismo request. Esto funciona, pero tiene dos limitaciones estructurales:

1. **Invisibilidad del cliente.** El cliente solo ve la salida final (o los deltas de razonamiento); no participa en las fases intermedias. Un cliente agéntico (p. ej. `opencode` con el plugin `opencode-swarm`) no puede inspeccionar, auditar ni influir en el plan, la ejecución ni la evaluación.
2. **Tiempos de respuesta largos.** Un bucle de N rondas mantiene abierta una sola conexión durante todo el proceso (decenas de segundos a minutos), lo que choca con timeouts de clientes y proxies intermedios.

La decisión (FASE 6) es convertir las tres fases no-iniciales (planificar / ejecutar / evaluar) en **delegaciones a subagentes del propio cliente**: el proxy emite un tool call estándar hacia la herramienta de creación de subagentes que el cliente ofrece en `tools`, y la conversación con el subagentes — y con el padre — avanza en peticiones HTTP independientes, con el estado serializable en `SessionStore`.

## Decisiones

### Decisión Tomada

**El proxy se convierte en orquestador de fases delegadas, con degradación segura al bucle inline.**

| Componente | Descripción | Ubicación |
|------------|-------------|-----------|
| **Fase de mapeo** | Antes de delegar, un único (máx. 2) upstream call le pregunta al modelo *su propia* herramienta de spawn entre las `tools` del cliente, qué argumentos portan title/type/prompt, y **listar TODOS los tipos de subagente** que esa herramienta puede lanzar (id + descripción, del más genérico al más especializado). El modelo elige **UN solo tipo** (el de propósito general; si no existe, el más apropiado para todas las fases) y ese tipo es **validado como existente**: debe estar en su propia lista, y cuando el argumento type tiene un `enum` real en el schema del cliente, todos los ids listados deben estar en ese enum. Formato compacto de tools (nombre + descripción ≤300 chars + argumentos con enums), `max_tokens: 8192` (los modelos de razonamiento gastan el presupuesto en thinking). | `src/core/subagent-mapper.ts` |
| **Envelope de spawn** | Prompt del tool call: línea 1 = JSON `{"phase","parent_session_id","agent_id"}`, línea 2 vacía, línea 3+ = descripción de la tarea. `agent_id` **nunca** viaja como argumento del tool call — solo dentro del envelope (evita depender del schema del tool del cliente). | `src/core/subagent-spawn.ts` |
| **Orquestador** | Máquina de estados `planify → execute → evaluate → [siguiente ronda] | done`, serializable en `LoopStateData` (vive en la sesión del padre en `SessionStore`, TTL 30 min). `start()` = mapeo + interpret + spawn(planify). `resume()` = consume el resultado de la fase y emite el siguiente spawn o la respuesta final (**sincrónico**, sin upstream call). `runSubagentPhase()` = ejecuta UNA fase para la primera petición del subagente. | `src/core/orchestrator.ts` |
| **Tri-partición en routes** | (1) El prompt lleva un envelope → es un subagente (primera petición = correr la fase; continuaciones = petición normal, su último contenido actualiza el resultado de la fase — *last content wins*). (2) La sesión propia lleva `loopState` → parent resume. (3) Petición nueva con tools + `x-session-id` y sin sesión guardada → `orchestrator.start()`. Si el mapeo falla (`null`) → **fall-through al bucle inline clásico** (comportamiento FASE 2/3 intacto). | `src/routes.ts` |
| **Endurecimiento (live run)** | En `resume()`, si el resultado de la fase pendiente **aún no llegó** (el cliente bloqueó o no ejecutó el subagente), el proxy **re-emite el mismo spawn** (mismo `agent_id`) sin consumir el estado: las rondas solo avanzan con un resultado real, de modo que un subagente bloqueado nunca hace girar el bucle con salidas vacías. **Failover de tipo:** tras `SPAWN_RETRY_THRESHOLD` (3) re-emisiones sin resultado, el orquestador rota al **siguiente tipo disponible** (el mapeo guarda todos los tipos) y re-dispara con un `agent_id` nuevo. El tipo que por fin produce un resultado queda **fijado para el resto de la sesión**. Sin candidatos más, se queda re-emitiendo de forma estable. | `src/core/orchestrator.ts` |

### Formato de resultado canónico

El resultado de una fase es el **último** `content` del subagente (no el primero), porque un subagente puede hacer varias llamadas LLM internas antes de terminar.

### Prompts compartidos

`src/core/phase-prompts.ts` es la única fuente de los prompts de cada fase (planify/execute/evaluate) y de la shaping de mensajes (R1: los mensajes `assistant` viajan con su rol real; fallback *rendered* ante rechazo 4xx del upstream, sticky para el resto de la ejecución). El bucle inline (`agent-loop.ts`) y el orquestador usan los mismos builders, por lo que los routers de los stubs de test y el comportamiento live coinciden en las mismas marcas de texto.

### Mecanismo de failover y re-emisión (endurecimiento)

En `resume()`, el resultado de la fase pendiente es el de la sesión (`phaseResults`):

- **Resultado disponible** → se consume (last content wins), se avanza la máquina de estados, y si el
  spawn en curso es el mismo agente se resetea el contador de re-emisiones (el tipo queda fijado).
- **Sin resultado** (el cliente bloqueó o no ejecutó el subagente) → el proxy **re-emite el mismo
  spawn** (mismo `agent_id`) sin consumir el estado; el contador `spawnRetries` crece. Tras
  `SPAWN_RETRY_THRESHOLD` re-emisiones sin resultado (configurable vía la variable de entorno
  `SPAWN_RETRY_THRESHOLD`, por defecto 3), si quedan tipos disponibles, se rota al
  siguiente y se re-dispara con un `agent_id` nuevo. Sin candidatos más, se queda re-emitiendo de
  forma estable.

### Detección de drift de la lista de tipos (re-mapeo entre peticiones)

El cliente puede cambiar la lista de tipos de subagente que ofrece entre peticiones (o renombrar
la herramienta de spawn). `detectTypeDrift()` (en `subagent-spawn.ts`) lo detecta de forma
**determinista, sin intervenir el modelo**: la única fuente maquina-legible de la lista es el
`enum` del argumento `type` de la herramienta en el esquema entrante. Se evalúa en la rama de
**parent-resume** (nunca durante una fase subagente: esas peticiones entran por la rama de
envelope). Drift confirmado = la herramienta de spawn desapareció de `tools`, o el argumento
`type` tiene un `enum` real y ninguno de los ids de `spec.availableTypes` aparece en él. Si el
argumento es free-form (sin `enum`), el drift **no es detectable sin el modelo** y no se
re-mapea (restricción explícita: no preguntarle al modelo para detectarlo). Al confirmar drift,
la ruta re-ejecuta `mapSubagentTool` (la única llamada upstream del mecanismo); si el re-mapeo
falla, se conserva la especificación anterior y se aplica el failover/re-emisión sobre ella.

### Alternativas Consideradas

| Alternativa | Ventajas | Desventajas | Por qué no se eligió |
|-------------|----------|-------------|---------------------|
| **Protocolo propietario de eventos (SSE custom)** | Control total sobre el wire | Rompe la compatibilidad OpenAI que todo el proxy garantiza; ningún cliente estándar lo hablaría | El wire debe permanecer `chat.completion` / `chat.completion.chunk`; la narración de fases va por deltas de `reasoning`, el contenido por `content` |
| **Delegar también la fase interpret** | Fase extra visible para el cliente | `interpret` es la base del bucle y su JSON es interno; delegarla complica el contrato sin beneficio de visibilidad | Solo se delegan planify/execute/evaluate; interpret corre en el padre (su razonamiento sí se streama) |
| **`agent_id` como argumento del tool call** | Más "propio" del protocolo del cliente | Depende del schema de la herramienta del cliente (que puede no tener ese campo) y contamina argumentos que el cliente puede mutar | El envelope JSON en el prompt es la única fuente de verdad; el mapper mapea solo title/type/prompt |
| **Un solo request largo (status quo)** | Simple | Limitaciones 1 y 2 del Contexto | Es el problema que resuelve esta decisión |
| **Estado en memoria no serializable** | Más rápido | Muere con el proceso; imposible de auditar | `LoopStateData` es JSON puro y vive en `SessionStore` (TTL + `subagentBindings`) |

### Reglas del contrato de peticiones

- **R1:** los mensajes `assistant` viajan al modelo como `assistant` — nunca aplastados en `system`/`user`.
- **R2:** todo lo que el sistema hace debe ser visible en el cliente: narración de fases por deltas de `reasoning`; `content` = la respuesta real.
- **R3:** cada fase (salvo la primera, interpret) se delega vía tool call de spawn; la petición del subagente se identifica por el envelope JSON en el prompt.

## Consecuencias

### Positivas

- El cliente **ve y controla** cada fase (títulos `planify (round N)` / `execute (round N)` / `evaluate (round N)`). **Un único tipo de subagente** (el de propósito general) se usa para todas las fases; si falla, **failover secuencial** por los tipos disponibles (los que el mapeo enumeró) hasta encontrar uno que funcione, que queda **fijado** para la sesión. El tipo elegido siempre existe (validado contra la lista del propio modelo y contra el `enum` real del schema cuando hay).
- Cada fase es una petición HTTP corta → sin conexiones de varios minutos, timeouts amables.
- Estado serializable → auditable y recuperable dentro del TTL.
- **Fail-safe total:** sin herramienta de spawn, o con un modelo incapaz de mapearla, la petición degrada al bucle inline clásico. Ninguna petición se rompe.
- Compatibilidad atrás garantizada: `AgentLoop.run()` no se modificó; el orquestador es una clase separada y los tests FASE 2 pasan intactos.

### Negativas / Riesgos

| Riesgo | Mitigación |
|--------|-----------|
| La herramienta de spawn del cliente puede tener contratos extra (p. ej. el plugin `opencode-swarm` exige un campo `ACCEPTANCE:` en el prompt de delegación) y bloquear el dispatch | Comportamiento cliente-side; el proxy re-emite el mismo spawn de forma estable (endurecimiento), rota de tipo al fallar (failover) y la sesión caduca por TTL. La degradación al bucle inline sigue disponible. |
| El modelo inventa un tipo de subagente que el cliente no reconoce | Doble validación: `type_id` debe existir en la lista que el propio modelo enumeró (`parseSpawnSpec`), y todos los ids deben estar en el `enum` real del argumento type cuando el schema lo lleva (mapper). Con string libre, el prompt prefiere el tipo más genérico. |
| El modelo local puede ser incapaz de mapear la herramienta (presupuesto de salida en thinking) | `max_tokens: 8192` + prompt compacto (verificado live: mapeo exitoso en el primer intento con `llama_cpp/default`); si aún falla → inline |
| Cuerpos de petición grandes (89–218 tool schemas + conversación acumulada ≈ 1 MB) pueden exceder el `bodyLimit` del proxy → 413 intermitentes | `bodyLimit` del servidor en **16 MB** (`routes.ts`); el contexto de las fases sigue limitado por diseño (`max_rounds`, bullets truncados) |
| La lista de tipos de subagente que ofrece el cliente cambia entre peticiones | Detección determinista de drift (`detectTypeDrift`) + re-mapeo automático en la rama de parent-resume. Limitación aceptada: con argumento `type` free-form (sin `enum`) el drift no es detectable sin el modelo y no se re-mapea |
| Complejidad de `routes.ts` (3 ramas + helpers) | Helpers separados (`handleSubagentPhase`, `recordSubagentResult`, `toFinalResult`) y tests unitarios del orquestador/mapeo/spawn |

## Evidencia de verificación live

Con `opencode` (218 tools, `opencode-swarm`) contra `llama_cpp/default`:

1. Mapeo exitoso en el primer intento con un único tipo: `tool="task" args={title:description,type:subagent_type,prompt:prompt} type="default" available=[default]` — el cliente (opencode-swarm) acepta el tipo y muestra **Default Agent** en el dispatch. (Evolución: antes, `phase_types={planify:explorer,execute:coder,evaluate:reviewer}` por fase; después, `type="task"` general; ahora, un solo tipo validado + lista de failover.)
2. `start()` emite `spawn` de `planify (round 1)`; cada petición de parent-resume emite el siguiente spawn (`execute`, `evaluate`, `planify (round 2)`…), cada una en ~10 ms y 3 SSE frames.
3. Los subagentes se mostraron en el cliente con título y tipo (`planify (round 5) — Explorer Agent`), confirmando R2/R3 en el wire OpenAI estándar.
4. Con el plugin bloqueando los dispatches (contrato `ACCEPTANCE`), se activó el endurecimiento: re-emisión estable del mismo spawn sin avanzar rondas.
5. **Drift de tipos (verificación determinista vía HTTP):** inicio con `enum=[plan,build]` → mapeo `type="build"`, spawn `type=build`. Parent-resume con el mismo `enum` → **sin** re-mapeo (0.0 s, sin upstream call), re-emisión `type=build`. Parent-resume con `enum=[fresh,new]` → `WARN subagent type list drifted (previous type="build" no longer exists) — remapped type="new"` → spawn re-emitido con `type=new`.

**Happy path completo (run #11, `opencode --pure` sin plugins, 89 tools, `llama_cpp/default`):** el mapeador enumera los 9 types reales del cliente (`available=[sme,architect,explorer,coder,designer,docs,reviewer,critic,test_engineer]`) y elige `type="sme"`; el cliente ejecuta de verdad los subagentes `planify (round 1)` → `execute (round 1)` → `evaluate (round 1)` (cada fase ~48 s de LLM real a través del proxy) y el orquestador cierra con `decision=complete round=1 upstream_calls=5`, devolviendo la respuesta final a opencode. Requerido por ello: (a) el mapeador ya **no** trunca a 300 chars las descripciones de tools *spawn-like* (la lista de types válidos vive en el tramo final de la descripción; truncarla hacía que el modelo fabricara `type="default"`, rechazado por el cliente en runtime) — cap 4000 chars para spawn-like, 300 para el resto; (b) `bodyLimit` del servidor 1 MB → **16 MB** (cuerpos de ~1 MB de clientes con 89–218 tool schemas daban 413 intermitentes).

## Referencias

- [AGENTS.md](../../../AGENTS.md) — Documento principal del proyecto
- [A-002: Proveedores Soportados](./a-002-proveedores-soportados.md) — Endpoint unificado y contrato OpenAI
- [A-003: Patrón Agéntico Iterativo](./a-003-patron-agentico-iterativo.md) — El bucle que esta decisión extiende
- [plans/subagent-phase-delegation.md](../../../plans/subagent-phase-delegation.md) — Plan de implementación (FASE 6)
