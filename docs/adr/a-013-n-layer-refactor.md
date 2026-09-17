# A-013: Refactor N-Capas

**Estado:** Aceptada
**Fecha:** 2026-09-16
**Decisor(es):** Equipo + IA (asistente de refactor)

## Contexto

Tras las ADRs A-006…A-012, toda la lógica de la petición (`POST /v1/chat/completions`)
vivía en **un único módulo de ~1 100 líneas** (`src/routes.ts`): el caso de uso, los
serializadores wire, los hooks HTTP, el writer SSE, el captor de requests y el
mapeo de modelo estaban mezclados con la definición de la app Fastify. El dominio
(`AgentLoop`, `Orchestrator`, …) era puro, pero el resto no tenía capas: los tests de
comportamiento dependían del módulo de routes en su integridad, y cualquier cambio de
transporte (p. ej. añadir una API REST no-OpenAI) obligaba a tocar el corazón del
pipeline.

Objetivo: reorganizar el código en capas con flujo de dependencia unidireccional,
**sin cambiar un solo byte del wire** (ADRs A-006…A-012 siguen vigentes) y sin perder
cobertura (123 tests).

## Decisiones

### Decisión Tomada

Cuatro capas, dependencias **solo de arriba hacia abajo**:

```text
presentation/  (HTTP: Fastify, hooks, SSE)
     ↓
application/   (caso de uso: el pipeline completo de chat-completions)
     ↓
domain/        (lógica agéntica pura — SIN Fastify, env, fs)
     ↑ (implementa)
infrastructure/ (provider Vercel AI SDK, logger, env/config, capture)
```

- **`presentation/`** — `app.ts` (`createApp()`, composición; ADR A-001 intacto),
  `hooks.ts` (onRequest/onResponse/preValidation/error handler), `sse-channel.ts`
  (`SseResponseChannel`, la implementación del puerto), `sse-writer.ts` (A-012),
  `request-meta.ts` (scratch por request).
- **`application/`** — `chat-completion-service.ts` (el caso de uso: captura entrante,
  resolución de modelo, passthrough, tri-partición FASE 6, bucle inline,
  bookkeeping de sesión), `model-resolution.ts` (alias + context window, 1 fetch
  `/v1/models` por request), `openai-completion.ts` (serializadores wire),
  `passthrough.ts` (A-007/A-010), `response-channel.ts` (**puerto** `ResponseChannel`
  + adaptador `ChannelSink` a `LoopSink`).
- **`domain/`** — **puro** (cero dependencias externas; solo Node builtins):
  bucle agéntico, orquestador, fases, estado, `provider/types.ts` (**puerto**
  `ChatProvider`), `logging.ts` (**puerto** `TraceLogger` + `createNoopLogger()`),
  `agent-events.ts` (contrato de eventos loop↔SSE), `validation.ts`, `types.ts`,
  `safety/`.
- **`infrastructure/`** — provider Vercel AI SDK (implementa el puerto), logger
  (rotación + ANSI; implementa `TraceLogger`), `env.ts`/`config.ts`, `capture.ts`.

**Puertos (contratos) y su implementación:**

| Puerto | Definido en | Implementado por |
|---|---|---|
| `ChatProvider` | `domain/provider/types.ts` | `infrastructure/provider/openai-compatible-provider.ts` (+ stub en tests) |
| `TraceLogger` | `domain/logging.ts` | `infrastructure/logger.ts` (+ `createNoopLogger()` por defecto) |
| `ResponseChannel` | `application/response-channel.ts` | `presentation/sse-channel.ts` |
| `LoopSink` (eventos del loop) | `domain/agent-loop.ts` | `application/response-channel.ts` (`ChannelSink`) |

**Invariantes verificadas** (revisión por pasos): `tsc --noEmit` limpio; 123/123 tests
de la suite existente pasando; wire invariante (los tests de fase/passthrough/FASE 6
verifican bytes SSE/JSON exactos); `createApp()` sigue siendo factory pura (A-001);
el provider se crea **por request** (logger trazado por request); el dominio no importa
Fastify, `config`/`env`, ni fs (verificado con grep).

### Alternativas Consideradas

| Alternativa | Ventajas | Desventajas | Por qué no se eligió |
|-------------|----------|-------------|---------------------|
| **Hexagonal estricto** (todo inyectado por factory en el borde, application sin imports de infra) | Purismo máximo | El caso de uso (orquestar provider+loop+store) se vuelve un muñeco de plumas: `createApp` inyectaría 6+ dependencias y el service perdería cohesión | El beneficio no paga la complejidad; 4 capas con puertos bien puestos da la misma testabilidad real |
| **6 capas (separar infra en "adapters" por tecnología)** | Granularidad | Sobre-engineering para un proyecto de ~50 archivos | Minimalismo (principio 2) |
| **Mantener routes.ts monolítico** | Cero riesgo | Ya demostró el coste: cualquier ADR nueva tocaba el mismo file de 1 100 líneas | Era el motivo del refactor |

## Consecuencias

### Positivas

- **El wire es inmutable bajo el refactor**: los tests de fase, passthrough, FASE 6 y
  SSE (bytes exactos) son la red de seguridad; el refactor los pasa todos.
- **Testeabilidad sin HTTP**: el caso de uso (`ChatCompletionService`) se ejercita con
  cualquier implementación de `ResponseChannel` (la suite actual lo hace vía
  `inject` + `createApp`; el puerto lo permite sin responder).
- **Nuevo transporte gratis**: otra API (REST no-OpenAI, WebSocket, MCP…) es una nueva
  capa de presentation sobre el mismo service de application.
- **Dominio reutilizable**: `AgentLoop`/`SubagentOrchestrator` sin Fastify ni env —
  portable a un worker, CLI o test.
- **Dependencias auditables**: una regla (`domain` no importa nada de fuera) verificable
  con un grep; la auditoría del refactor la corrió y pasó.

### Negativas / Riesgos

- `application/` importa `infrastructure/` (config, capture): dirección permitida por el
  diseño de 4 capas (arriba→abajo), pero menos pura que la hexagonal estricta.
- El módulo `index.ts` sigue creando el provider real por defecto (composición en el
  borde): si crecen las fuentes de configuración, moverlas a un contenedor ligero.

## Referencias

- [A-001 — Lenguaje y Framework](./a-001-lenguaje-y-framework-principal.md) (import-safety de `createApp`)
- [A-006 — Delegación de Fases a Subagentes](./a-006-subagent-phase-delegation.md) (la tri-partición ahora vive en `application/chat-completion-service.ts`)
- [A-012 — SSE commit perezoso](./a-012-lazy-sse-commit.md) (preservado en `presentation/sse-writer.ts`)
- `src/application/response-channel.ts` — el puerto que une application y presentation.
