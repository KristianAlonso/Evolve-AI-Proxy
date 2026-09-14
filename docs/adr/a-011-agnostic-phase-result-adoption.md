# A-011: Adopción Agnóstica del Resultado de Fase (Plugin-Agnostic Phase-Result Adoption)

**Estado:** Aceptada
**Fecha:** 2026-09-14
**Decisor(es):** Equipo evolve_ai_proxy

## Contexto

A-006 asume un contrato ideal de delegación: el cliente **siempre** ejecuta el spawn y la salida de la fase regresa al proxy a través de la **sesión propia del subagente** (rama envelope → `runSubagentPhase` → `state.phaseResults[agentId] = …`). Ese es el único camino que, hasta ahora, llenaba el hueco de resultado de una fase.

En el mundo real, entre el proxy y el LLM hay **capas intermedias arbitrarias** (plugins de cliente, runners nativos de subagentes, orquestadores propios del cliente). Observación live (opencode + plugin `opencode-swarm`):

1. El plugin **ejecutó el spawn dentro de sí mismo** (con su propia infraestructura: gates de `ACCEPTANCE`/`SKILLS`/`plan.json`) y **nunca** habló con el proxy como subagente. El resultado de la fase volvió como un **`tool` message ordinario** en la conversación del **padre** (el id del tool call del spawn se conserva: `spawn_<agent_id>`).
2. El proxy, al no recibir la sesión subagente, veía `phaseResults` vacío y entraba en **failover infinito** (rota de tipo en tipo, `consecutive_failures` creciente, `stage=planify round=1` perpetuo). El proxy estaba asumiendo implícitamente el contrato ideal de A-006, no el que el cliente real cumplía.

La exigencia del usuario: **el sistema debe ser agnóstico a cualquier plugin y funcionar de forma transparente, como si nada existiera en medio.** Es decir, el proxy no puede depender de que el subagente hable con él; debe reconocer el resultado de la fase **dondequiera que el cliente lo devuelva**, usando solo el wire OpenAI estándar.

## Decisión Tomada

**En `resume()`, si el resultado de la fase pendiente aún no llegó por la sesión del subagente, el proxy lo busca y lo **adopta** de la conversación entrante del padre — sin conocimiento (ni dependencia) de ningún plugin, envelope o marcador propio.**

| Aspecto | Descripción |
|---------|-------------|
| **Detección strict** | Un `tool` message cuyo `tool_call_id` coincide con el id del spawn que el orquestador emitió (`spawn_<agent_id>`; también `<agent_id>` o un sufijo, para tolerar re-mint del id). El cliente debe conservar los ids de tool calls — garantía estándar del wire OpenAI. |
| **Detección loose** | Clientes que **re-mintean** los ids de tool: el **primer** `tool` message que sigue al **último** turno `assistant` con `tool_calls` (ese turno es el spawn que el proxy emitió, así que la primera respuesta de tool que le sigue es su resultado). |
| **Agnosticismo total** | El contenido se adopta **tal cual**, sea lo que sea. Si un plugin de en medio bloqueó el dispatch y devolvió un error, es ese error el resultado: el cliente ya lo ve en su propia conversación, y el proxy **no** clasifica ni interpreta el contenido (no es su trabajo). El proxy permanece **transparente**. |
| **Failover intacto** | Si **no** hay resultado adoptable (el cliente ni siquiera devolvió respuesta al spawn), se conserva el comportamiento de A-006: re-emisión estable / failover de tipo. La adopción es una *nueva fuente* de resultado, no una reescritura del failover. |
| **Prompt con `ACCEPTANCE:`** | La línea de tarea de cada spawn (`spawnTaskDescription`) lleva una línea `ACCEPTANCE: DONE when …` (planify/execute/evaluate). Es texto de prompt inofensivo para clientes sin gate, y **obligatoria** para clientes con un knowledge-gate (p. ej. opencode-swarm) que bloquean cualquier dispatch sin ella. Sin esa línea, el plugin devuelve un error instantáneo y el resultado (aunque adoptable) no es un output real de fase. |

### Ubicaciones

- `src/core/orchestrator.ts` — `SubagentOrchestrator.resume()`: rama de adopción antes del failover. `SubagentOrchestrator.findSpawnResultInPile(agentId, messages)`: detección strict + loose. `SubagentOrchestrator.spawnTaskDescription()`: línea `ACCEPTANCE:` por fase.
- `src/test/subagent-delegation.test.ts` — casos de adopción (strict, loose, y *no*-adopción de resultado stale).

## Consideraciones / Consecuencias

1. **El proxy es ahora transparente a plugins de en medio.** Funciona igual el cliente que ejecuta el spawn internamente (plugin), el que lo ejecuta nativamente (runner) o el que lo delega de vuelta al proxy (contrato ideal de A-006). Ninguna de las tres requiere código distinto en el proxy.
2. **El proxy no es el dueño del resultado.** El "resultado" es lo que el cliente pone en el `tool` message. Si un plugin de en medio inyecta su propio error (p. ej. `SCOPE_NOT_DECLARED`), ese error **es** la salida de la fase para el proxy. La corrección de un bloque de plugin es responsabilidad del **plugin**, no del proxy.
3. **Dos orquestadores no deben pelear.** Si un plugin ya implementa su propio bucle agéntico completo (plan/ejec/eval), delegar las fases a través del spawn del proxy **y** dejar que el plugin haga lo mismo produce dos máquinas de estados superpuestas. La adopción agnóstica *concilia* la colisión (el bucle del proxy avanza y termina), pero la **semántica** final la decide el contenido que el plugin devuelva. Para un uso limpio sin colisión: o el cliente delega (contrato A-006), o corre `--pure` y usa el bucle del proxy.
4. **El id del spawn es el contrato.** La adopción strict depende de que el cliente preserve el `tool_call_id` que el proxy emite (`spawn_<agent_id>`). Los clientes que re-mintean quedan cubiertos por la rama loose (primer `tool` tras el último `assistant` con `tool_calls`).

## Alternativas Consideradas

| Alternativa | Descarte |
|-------------|----------|
| **A. Forzar el contrato ideal de A-006** (exigir que el subagente hable con el proxy) | Excluye a los clientes con runner/plugin interno. Rompe la exigencia de agnóstico y transparencia. |
| **Heurísticas del plugin** (parsear `SCOPE_NOT_DECLARED`, `Blocked by…`, `<task_result>`) | Acopla el proxy a un plugin concreto. Viola "agnóstico a cualquier plugin". Descartado explícitamente. |
| **Adoptar solo strict** (solo `tool_call_id` exacto) | Clientes que re-mintean ids (o plugins que envuelven la respuesta) dejarían el resultado huérfano → failover. La rama loose lo cubre sin asumir plugin. |

## Enlaces

- A-006 (delegación de fases a subagentes — contrato base que esta decisión **extiende** sin reescribir).
- A-008 (phase-prompt shaping — los builders de instrucción sobre los que se añade la línea `ACCEPTANCE:`).
