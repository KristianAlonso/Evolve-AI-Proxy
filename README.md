# evolve_ai_proxy

Proxy AI OpenAI-compatible con bucle agéntico iterativo, streaming en tiempo real, trazabilidad completa por request y propagación de cancelación al upstream.

- **Licencia:** Apache 2.0
- **Stack:** Node.js (≥ 22) + Fastify 4 + TypeScript (strict) + Vercel AI SDK (`@ai-sdk/openai-compatible`)
- **Tests:** Vitest
- **Docs de agentes:** [`AGENTS.md`](./AGENTS.md) · **Decisiones:** [`docs/adr/`](./docs/adr)

## Qué es

`evolve_ai_proxy` no es un simple relé: expone un único endpoint compatible con la API de OpenAI
(`POST /v1/chat/completions`) que, internamente, ejecuta un **bucle agéntico iterativo**
(ADR A-003) contra cualquier upstream OpenAI-compatible (LiteLLM, Ollama, LM Studio, Groq, …):

```text
request → Interpretar → Planificar → Ejecutar → Evaluar → (condensar contexto) → repetir
          hasta: complete | tool_calls_pending | max_rounds | error
```

**Características principales:**

- **Streaming en tiempo real** — deltas de razonamiento y texto llegan al cliente en vivo (SSE,
  formato `chat.completion.chunk`; sin eventos propietarios en el wire).
- **Delegación bidireccional de tools** (FASE 2) — los tools que el cliente envía en el request se
  delegan al upstream solo en la fase *execute*; cuando el modelo pide un tool, el proxy responde
  `finish_reason: "tool_calls"` y el cliente lo ejecuta y reenvía la conversación (resumen por
  `x-session-id`).
- **Trazabilidad completa** — un `trace_id` por request recorre todo el sistema (routes → loop →
  provider → capturas); logs con rotación + capturas JSON de cada request entrante y de cada
  llamada upstream.
- **Stop propagation** (FASE 4) — si el cliente corta la conexión o pide parar, el
  `AbortController` cancela la llamada upstream **en vuelo** (no se generan tokens para un cliente
  muerto) y el bucle se detiene sin reintentos.
- **Safety** — auto-healing con reintentos (falla rápido en errores deterministas: contexto
  excedido, auth, 4xx), detección de doom-loops, control de ventanas de contexto.

## Estructura

```text
.
├── app/                  # código del proxy (servidor)
│   ├── src/
│   │   ├── index.ts                  # entry point (main + guard de import-safety)
│   │   ├── routes.ts                 # Fastify app factory, hooks, SSE, capturas
│   │   ├── validate.ts               # validación de requests (400 con todos los issues)
│   │   ├── sse-writer.ts             # escritor SSE OpenAI-compatible
│   │   ├── logger.ts                 # logger con rotación + consola (ANSI)
│   │   ├── env.ts                    # carga .env con dotenv (primer import del entry)
│   │   ├── config.ts                 # variables de entorno (ver .env)
│   │   ├── core/                     # bucle agéntico: agent-loop, interpreter, task-generator,
│   │   │                             # evaluator, context-manager, session-store, stream-helper
│   │   ├── provider/                 # ChatProvider + impl. OpenAI-compatible (AI SDK v4)
│   │   ├── safety/                   # auto-healing retry, doom-loop, refusal
│   │   └── test/                     # unit + integración (live opcional)
│   ├── .env                          # variables de entorno (valores dev)
│   └── package.json
├── docs/adr/               # Architecture Decision Records
├── AGENTS.md               # instrucciones para agentes de IA
└── README.md
```

## Puesta en marcha

Requisitos: Node.js ≥ 22. La app carga [`app/.env`](./app/.env) **automáticamente al
arrancar** (`src/env.ts` vía `dotenv`): no hace falta exportar nada. El archivo `.env` está
en `.gitignore` — cópialo y llénalo en cada máquina. Las variables de entorno del shell
**siempre** tienen prioridad sobre el archivo.

```bash
cd app
pnpm install     # o npm install

# Arranque directo (lee app/.env solo):
npx tsx src/index.ts

# Override puntual (el shell gana sobre .env):
UPSTREAM_API_KEY="sk-otro" npx tsx src/index.ts
```

El servidor escucha en `http://0.0.0.0:8787` por defecto.

> **Nota (Windows/dev):** el proxy en desarrollo **no** corre con `tsx watch`; tras cambios de
> código hay que matar y relanzar el proceso (ver `AGENTS.md`).

### Ejemplos

```bash
# Non-streaming → JSON chat.completion
curl -X POST http://localhost:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"llama_cpp/default","messages":[{"role":"user","content":"Hola"}]}'

# Streaming (SSE, chat.completion.chunk)
curl -N -X POST http://localhost:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"llama_cpp/default","stream":true,
       "messages":[{"role":"user","content":"Escribe una función"}]}'

# Health check
curl http://localhost:8787/health
```

## Variables de entorno

Todas definidas en `app/src/config.ts` (y `logger.ts`), con su valor por defecto. Ver
[`app/.env`](./app/.env) para el archivo comentado.

| Variable | Default | Descripción |
| --- | --- | --- |
| `UPSTREAM_BASE_URL` | `http://26.238.135.219:4000` | Base URL del upstream OpenAI-compatible (LiteLLM). |
| `UPSTREAM_API_KEY` | *(vacio)* | Bearer token enviado al upstream en cada llamada. |
| `HTTP_PORT` | `8787` | Puerto de escucha. |
| `HTTP_HOST` | `0.0.0.0` | Interfaz de escucha. |
| `AUTO_RESOLVE_MODEL` | `true` | Resolver el modelo contra `/v1/models` si el request lo omite. |
| `FALLBACK_MODEL` | `gemini/gemini-2.5-flash` | Modelo de respaldo sin lista de modelos. |
| `LOG_DIR` | `./logs` | Directorio de logs (rotación a 10 MB/archivo). |
| `CONSOLE_LOG` | `true` | Espejar cada línea de log a stdout/stderr. |
| `CAPTURE_DIR` | `./captures` | Directorio de capturas (request entrante + `upstream/`). |
| `CAPTURE_REQUESTS` | `true` | Habilitar capturas JSON a disco. |
| `SPAWN_RETRY_THRESHOLD` | `3` | **FASE 6:** re-emisiones del mismo spawn de fase (sin resultado) toleradas antes del failover al siguiente tipo de subagente. |
| `FORCE_COLOR` | *(off)* | Forzar color ANSI aunque la salida no sea TTY. |
| `NO_COLOR` | *(off)* | Desactivar color ANSI aunque sea TTY. |

## Observabilidad

- **`trace_id`** por request (honra el header entrante `x-trace-id`; si no, lo genera y lo devuelve
  en el header de respuesta). Todo el ciclo de vida del request es recuperable con
  `grep <trace_id> logs/evolve-proxy-*.log`.
- **Logs** (`app/logs/evolve-proxy-YYYYMMDD.log`): una línea por operación — request entrante,
  resolución de modelo, cada fase del bucle con duración, cada llamada upstream, errores y fin.
  La consola emite además una **línea de resultado coloreada** por request
  (`<ip> <METHOD> <endpoint> (HTTP/1.1) stream=yes → 200 (8331ms)`).
- **Capturas** (dos capas, desactivables con `CAPTURE_REQUESTS=false`):
  - entrante → `app/captures/<UTC>_<traceId>.json`
  - upstream → `app/captures/upstream/<UTC>_<traceId>_{request,response,error}.json`
- **Error handler global**: ningún 4xx/5xx es silencioso (JSON malformado incluido).

## Tests

```bash
cd app
npx vitest run                              # unit + live (necesita UPSTREAM_API_KEY)
npx vitest run --exclude src/test/integration.live.test.ts   # solo unit
npx tsc --noEmit                            # chequeo de tipos
```

Los tests live (`src/test/integration.live.test.ts`) requieren el upstream accesible y la variable
`UPSTREAM_API_KEY`.

## Convenciones

- TypeScript strict; Conventional Commits; Vitest; ESLint/Prettier pendiente de configurar.
- Decisiones arquitecturales importantes → ADR en `docs/adr/`.
- Principios (validación primero, minimalismo de dependencias, documentación de decisiones) en
  [`AGENTS.md`](./AGENTS.md).
