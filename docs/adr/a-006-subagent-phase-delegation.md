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
| **Fase de mapeo** | Antes de delegar, un único (máx. 2) upstream call le pregunta al modelo *su propia* herramienta de spawn entre las `tools` del cliente, y cuáles de sus argumentos portan title/type/prompt. Formato compacto de tools (nombre + descripción ≤300 chars + argumentos con enums), `max_tokens: 8192` (los modelos de razonamiento gastan el presupuesto en thinking). | `src/core/subagent-mapper.ts` |
| **Envelope de spawn** | Prompt del tool call: línea 1 = JSON `{"phase","parent_session_id","agent_id"}`, línea 2 vacía, línea 3+ = descripción de la tarea. `agent_id` **nunca** viaja como argumento del tool call — solo dentro del envelope (evita depender del schema del tool del cliente). | `src/core/subagent-spawn.ts` |
| **Orquestador** | Máquina de estados `planify → execute → evaluate → [siguiente ronda] | done`, serializable en `LoopStateData` (vive en la sesión del padre en `SessionStore`, TTL 30 min). `start()` = mapeo + interpret + spawn(planify). `resume()` = consume el resultado de la fase y emite el siguiente spawn o la respuesta final (**sincrónico**, sin upstream call). `runSubagentPhase()` = ejecuta UNA fase para la primera petición del subagente. | `src/core/orchestrator.ts` |
| **Tri-partición en routes** | (1) El prompt lleva un envelope → es un subagente (primera petición = correr la fase; continuaciones = petición normal, su último contenido actualiza el resultado de la fase — *last content wins*). (2) La sesión propia lleva `loopState` → parent resume. (3) Petición nueva con tools + `x-session-id` y sin sesión guardada → `orchestrator.start()`. Si el mapeo falla (`null`) → **fall-through al bucle inline clásico** (comportamiento FASE 2/3 intacto). | `src/routes.ts` |
| **Endurecimiento (live run)** | En `resume()`, si el resultado de la fase pendiente **aún no llegó** (el cliente bloqueó o no ejecutó el subagente), el proxy **re-emite el mismo spawn** (mismo `agent_id`) sin consumir el estado: las rondas solo avanzan con un resultado real, de modo que un subagente bloqueado nunca hace girar el bucle con salidas vacías. | `src/core/orchestrator.ts` |

### Formato de resultado canónico

El resultado de una fase es el **último** `content` del subagente (no el primero), porque un subagente puede hacer varias llamadas LLM internas antes de terminar.

### Prompts compartidos

`src/core/phase-prompts.ts` es la única fuente de los prompts de cada fase (planify/execute/evaluate) y de la shaping de mensajes (R1: los mensajes `assistant` viajan con su rol real; fallback *rendered* ante rechazo 4xx del upstream, sticky para el resto de la ejecución). El bucle inline (`agent-loop.ts`) y el orquestador usan los mismos builders, por lo que los routers de los stubs de test y el comportamiento live coinciden en las mismas marcas de texto.

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

- El cliente **ve y controla** cada fase (títulos `planify (round N)` / `execute (round N)` / `evaluate (round N)` con el tipo de subagente que elige el modelo, p. ej. `explorer` / `coder` / `reviewer`).
- Cada fase es una petición HTTP corta → sin conexiones de varios minutos, timeouts amables.
- Estado serializable → auditable y recuperable dentro del TTL.
- **Fail-safe total:** sin herramienta de spawn, o con un modelo incapaz de mapearla, la petición degrada al bucle inline clásico. Ninguna petición se rompe.
- Compatibilidad atrás garantizada: `AgentLoop.run()` no se modificó; el orquestador es una clase separada y los tests FASE 2 pasan intactos.

### Negativas / Riesgos

| Riesgo | Mitigación |
|--------|-----------|
| La herramienta de spawn del cliente puede tener contratos extra (p. ej. el plugin `opencode-swarm` exige un campo `ACCEPTANCE:` en el prompt de delegación) y bloquear el dispatch | Comportamiento cliente-side; el proxy re-emite el mismo spawn de forma estable (endurecimiento) y la sesión caduca por TTL. La degradación al bucle inline sigue disponible. |
| El modelo local puede ser incapaz de mapear la herramienta (presupuesto de salida en thinking) | `max_tokens: 8192` + prompt compacto (verificado live: mapeo exitoso en el primer intento con `llama_cpp/default`); si aún falla → inline |
| Cuerpos de conversación que crecen entre peticiones pueden exceder límites de tamaño del upstream (se observó `Payload Too Large` en un run live) | Fuera de alcance del contrato de delegación; el contexto de las fases ya está limitado por diseño (`max_rounds`, bullets truncados) |
| Complejidad de `routes.ts` (3 ramas + helpers) | Helpers separados (`handleSubagentPhase`, `recordSubagentResult`, `toFinalResult`) y tests unitarios del orquestador/mapeo/spawn |

## Evidencia de verificación live

Con `opencode` (218 tools, `opencode-swarm`) contra `llama_cpp/default`:

1. Mapeo exitoso en el primer intento: `tool="task" args={title:description,type:subagent_type,prompt:prompt} phase_types={planify:explorer,execute:coder,evaluate:reviewer}`.
2. `start()` emite `spawn` de `planify (round 1)`; cada petición de parent-resume emite el siguiente spawn (`execute`, `evaluate`, `planify (round 2)`…), cada una en ~10 ms y 3 SSE frames.
3. Los subagentes se mostraron en el cliente con título y tipo (`planify (round 5) — Explorer Agent`), confirmando R2/R3 en el wire OpenAI estándar.
4. Con el plugin bloqueando los dispatches (contrato `ACCEPTANCE`), se activó el endurecimiento: re-emisión estable del mismo spawn sin avanzar rondas.

## Referencias

- [AGENTS.md](../../../AGENTS.md) — Documento principal del proyecto
- [A-002: Proveedores Soportados](./a-002-proveedores-soportados.md) — Endpoint unificado y contrato OpenAI
- [A-003: Patrón Agéntico Iterativo](./a-003-patron-agentico-iterativo.md) — El bucle que esta decisión extiende
- [plans/subagent-phase-delegation.md](../../../plans/subagent-phase-delegation.md) — Plan de implementación (FASE 6)
