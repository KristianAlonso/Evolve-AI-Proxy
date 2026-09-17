# Architecture Decision Records — evolve_ai_proxy

Registro de decisiones arquitecturales que han dado forma al diseño y la evolución del sistema.

## Decisiones Registradas

| ID | Título | Estado | Descripción |
|----|--------|--------|-------------|
| [A-001](./a-001-lenguaje-y-framework-principal.md) | Lenguaje y Framework Principal | **Aceptada** | Node.js + Fastify como stack principal por rendimiento, validación nativa y hooks del lifecycle. |
| [A-002](./a-002-proveedores-soportados.md) | Proveedores Soportados | **Aceptada** | Endpoint unificado `POST /v1/chat/completions` compatible con OpenAI API para Ollama, Anthropic y Google Gemini. |
| [A-003](./a-003-patron-agentico-iterativo.md) | Patrón Agéntico Iterativo | **Aceptada** | Sistema de interpretación → planificación → ejecución → evaluación en bucle controlado para resolver solicitudes complejas. |
| [A-006](./a-006-subagent-phase-delegation.md) | Delegación de Fases a Subagentes | **Aceptada** | Las fases planificar/ejecutar/evaluar se delegan al cliente vía tool call de spawn (formato OpenAI estándar); estado serializable en `SessionStore`; degradación segura al bucle inline. |
| [A-007](./a-007-passthrough-intacto.md) | Passthrough-Intacto de la Petición | **Aceptada** | El proxy reenvía al upstream la petición del cliente verbatim (salvo `messages` y `model`); sin valores inventados (eliminan los `max_tokens` forzados 512/128/8192); campos estándar mapeados a opciones v4, el resto via `providerOptions` raw del SDK. |
| [A-008](./a-008-phase-prompt-shaping.md) | Phase-Prompt Shaping | **Aceptada** | Toda llamada upstream de fase usa una forma canónica: conversación del cliente intacta (sin `system` añadidos) + el último mensaje intermedio (un turno `assistant`) + la instrucción de fase al final (`user`). Elimina el `ContextManager` y la acumulación de contexto; inline y orquestador comparten la misma forma. |
| [A-009](./a-009-passthrough-sin-tools.md) | Passthrough de Peticiones sin Tools | **Aceptada** | Toda petición sin `tools` (auxiliares del cliente, p. ej. el title-generator de OpenCode) es passthrough puro: 1 llamada upstream, messages intactos, sin tocas el `SessionStore`. Evita que un bucle inline sobre una petición auxiliar borre la `loopState` del padre y reinicie el flujo delegado. |
| [A-010](./a-010-openai-cache-identifiers.md) | Identificadores de Caché OpenAI | **Aceptada** | Los identificadores de caché del cliente (`prompt_cache_key`/`promptCacheKey`/`set_cache_key`) se normalizan al campo estándar `prompt_cache_key` en `buildPassthrough`; sin valor del cliente se sintetiza `evolve_<x-session-id>` (sin sesión, no se inventa nada). Así llama.cpp/LiteLLM reciben un identificador de caché OpenAI en todas las llamadas upstream. |
| [A-011](./a-011-agnostic-phase-result-adoption.md) | Adopción Agnóstica del Resultado de Fase | **Aceptada** | En `resume()`, si el resultado de la fase no llegó por la sesión del subagente, el proxy lo **adopta** de la conversación del padre (id del spawn exacto, o primer `tool` tras el último `assistant` con tool_calls) — sin depender de ningún plugin. El proxy es transparente a cualquier capa intermedia. Los spawns llevan línea `ACCEPTANCE:` (gate de plugins). El failover de A-006 queda intacto cuando no hay nada que adoptar. |
| [A-013](./a-013-n-layer-refactor.md) | Refactor N-Capas | **Aceptada** | El monolito `routes.ts` se reorganiza en 4 capas (presentation → application → domain → infrastructure) con puertos (`ChatProvider`, `TraceLogger`, `ResponseChannel`, `LoopSink`) y dominio puro; wire y tests invariables (123/123). |
| [A-012](./a-012-lazy-sse-commit.md) | SSE commit perezoso y errores de upstream sin crash | **Aceptada** | El `SseWriter` ya no committea headers/estado en el constructor (hace en el primer frame real); un fallo de upstream antes del primer byte devuelve **502 JSON** limpio (no un stream a medio abrir), y el error-handler global cierra el stream en vez de lanzar `ERR_HTTP_HEADERS_SENT`. El `model` pedido se reenvía verbatim cuando el fetch de `/v1/models` falla. |

## Formato de los ADRs

Cada Architecture Decision Record sigue esta estructura:

```markdown
# A-XXX: [Título]

**Estado:** [Propuesta | Aceptada | Rechazada | Superseded | Obsoleta]
**Fecha:** YYYY-MM-DD
**Decisor(es):** [Equipo / Persona]

## Contexto

[Descripción del problema o situación que motiva la decisión.]

## Decisiones

### Decisión Tomada

[Qué se decidió y por qué.]

### Alternativas Consideradas

| Alternativa | Ventajas | Desventajas | Por qué no se eligió |
|-------------|----------|-------------|---------------------|
| Opción A | ... | ... | ... |
| Opción B | ... | ... | ... |

## Consecuencias

### Positivas

- [Efectos beneficiosos de la decisión]

### Negativas / Riesgos

- [Costos, compensaciones o riesgos asociados]

## Referencias

- [Enlaces a documentación relacionada, otros ADRs, etc.]
```

## Estados de un ADR

| Estado | Significado |
| -------- | ------------- |
| **Propuesta** | Decisión sugerida, en revisión. No implementada aún. |
| **Aceptada** | Decisión aprobada y vigente. Base del diseño actual. |
| **Rechazada** | Alternativa considerada pero descartada. |
| **Superseded** | Reemplazada por un ADR posterior (ej: A-001 → A-010). |
| **Obsoleta** | Ya no aplica al proyecto actual. |

## Cómo Contribuir

Cuando se tome una decisión arquitectural significativa:

1. Crear nuevo archivo `docs/adr/a-XXX-[titulo-en-kebab-case].md`
2. Numeración secuencial (A-003, A-004, ...)
3. Actualizar este índice con la nueva entrada en la tabla
4. Referenciar el ADR desde `AGENTS.md` si aplica

## Principios Rectores

Estos principios se mencionan frecuentemente en los ADRs y guían las decisiones:

1. **Validación primero** — Todo request debe validarse contra un schema JSON antes de procesarse
2. **Minimalismo** — No añadir dependencias sin justificar el valor real que aportan
3. **Documentar todo** — Decisiones importantes se registran como ADRs
