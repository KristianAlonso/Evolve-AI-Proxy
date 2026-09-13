# evolve_ai_proxy — Instrucciones para Agentes de IA

## Proyecto

**evolve_ai_proxy** es un proxy para servicios de inteligencia artificial. Licencia Apache 2.0.

- **Stack:** Node.js + Fastify
- **Plataforma de desarrollo:** Windows (PowerShell)
- **Estado:** Definido — decisiones arquitecturales iniciales tomadas

## Decisiones arquitecturales

### A-001: Lenguaje y Framework Principal

**Decisión:** Node.js + Fastify

| Criterio | Justificación |
| ---------- | --------------- |
| **Rendimiento** | Fastify es ~3x más rápido que Express, crítico porque cada request pasa por múltiples hops (cliente → proxy → proveedor IA) |
| **Validation nativa** | JSON Schema integrado — validamos requests/responses sin plugins externos, esencial para un proxy que transforma inputs |
| **Hooks del lifecycle** | `onRequest`, `preParsing`, `preValidation`, `onError` permiten logging, auth checks y transformación en puntos controlados |
| **TypeScript** | Soporte nativo con `@fastify/typebox-type-provider` — tipado estricto desde el día 1 |
| **Ecosistema npm** | Amplio pero selectivo — usaremos solo lo que añada valor real, sin dependencias innecesarias |

### A-002: Proveedores Soportados

El proxy soporta las siguientes fuentes de modelos IA via un endpoint unificado compatible con OpenAI API (`POST /v1/chat/completions`):

| Proveedor | Tipo | Notas |
| ----------- | ------ | ------- |
| Ollama / LM Studio | Local | Modelos locales, sin costo, offline. Endpoint compatible OpenAI |
| Proveedores compatibles OpenAI | Cloud/SaaS | Groq, Together AI, Mistral (vía endpoint OpenAI), etc. |
| Anthropic (Claude) | Cloud | API nativa de Anthropic, mapeada al formato unificado del proxy |
| Google Gemini | Cloud | API de Google AI / Vertex AI |

**Formato de salida:** Chat completions (text). Embeddings pendiente de definir.

### A-003: Patrón Agéntico Iterativo

El proxy no es un simple relé — es un **sistema agéntico iterativo** que:

1. Recibe una solicitud del usuario
2. Interpreta y comprende en profundidad la petición (vía modelo IA)
3. Genera una tarea ejecutable basada en esa interpretación
4. Ejecuta la tarea y obtiene el resultado
5. A partir del resultado, genera una nueva tarea
6. Repite los pasos 4-5 iterativamente hasta cumplir la solicitud original

**Patrón:** Interpretar → Planificar → Ejecutar → Evaluar (bucle con límite configurable de rondas)

**Componentes clave:** `Interpreter`, `Planner`, `Executor`, `Evaluator`, `LoopController`

### A-008: Phase-Prompt Shaping

Toda llamada upstream de una fase del bucle (inline u orquestador) usa **una sola forma canónica** (`buildPhasePrompt` en `src/core/phase-prompts.ts`):

```text
[ ...baseCliente(intacta), ...(lastMessage ? [{role:'assistant', content:lastMessage}] : []), {role:'user', content:instruction} ]
```

- El `system` del cliente se conserva byte a byte; el proxy **nunca añade `system`** — las instrucciones de fase van al final como `user`.
- **Solo se conserva el último mensaje intermedio** (la salida cruda de la última fase, un único turno `assistant`); el historial de fases anterior se descarta — sin `ContextManager`.
- **Compaction de contexto delegada al cliente (SC-021/SC-022)**: el proxy NUNCA trunca ni condensa mensajes. Tras cada llamada upstream compara el `usage` real contra `context_window_size × CONTEXT_COMPACT_THRESHOLD` (env, por defecto 0.9; `context_window_size = 0` = sin check, el upstream decide). Al alcanzar el umbral: se interrumpe el bucle sin más llamadas (`context_compact_pending`), se **relee el `usage` real** al cliente (finish chunk SSE + JSON, para su tracking de tokens), la petición de compaction del cliente pasa **intacta** (passthrough puro, sin loop ni orquestador) y la siguiente petición adopta el contexto compactado — se descartan los mensajes viejos del estado y la fase interrumpida se re-emite (spawn estable mismo `agent_id` mientras el contexto siga lleno).
- **Anuncio de fase en tiempo real**: antes de cada fase (inline o delegada) el cliente recibe un delta de razonamiento `[fase] <qué va a hacer>` (wire 100 % OpenAI).
- **Flujo delegado**: la salida de cada fase la persiste el cliente como tool result; `resume()` refresca la base desde el montón entrante del padre y limpia `lastMessage` (solo el raw del interpret viaja como intermedio propio).
- Inline (`AgentLoop`) y orquestador (`SubagentOrchestrator`, FASE 6) comparten los mismos builders; el fallback sticky estructur→rendered (4xx) se aplica a todas las fases.
- Detalle: [docs/adr/a-008-phase-prompt-shaping.md](./docs/adr/a-008-phase-prompt-shaping.md)

## Estructura de carpetas (provisional)

```text
evolve_ai_proxy/
├── src/
│   ├── providers/          # Implementaciones por proveedor (openai, anthropic, gemini, ollama)
│   ├── proxy/              # Lógica central del proxy (routing, transformación, caching)
│   ├── middleware/           # Logging, auth, rate-limiting
│   └── index.ts            # Entry point — configura Fastify server
├── test/                   # Tests unitarios e integration
├── package.json
├── tsconfig.json
└── README.md
```

## Convenciones técnicas

- **TypeScript strict mode** habilitado desde el inicio
- **Linting:** ESLint + Prettier (configurar cuando se cree `package.json`)
- **Tests:** Vitest (native Node.js, compatible con TypeScript)
- **Commit conventions:** Conventional Commits (`feat:`, `fix:`, `docs:`, etc.)

## Observabilidad (trazabilidad)

- **Todo request lleva un `trace_id`** (header `x-trace-id`). El header se honra si el cliente lo envía; si no, el proxy genera uno (`tr_<base36ts>_<8 hex>`) y lo devuelve en el header de respuesta `x-trace-id` (y en `meta.trace_id` en la ruta no-stream).
- **Formato de línea de log** (`app/logs/evolve-proxy-YYYYMMDD.log`, append inmediato + rotación a 10 MB):

  ```text
  <ISO timestamp> [<LEVEL>] <session-id o -> <trace-id o -> <mensaje>
  ```

- **Cada operación deja una línea**: request recibido, resolución de modelo, configuración del loop, cada fase del agent loop (interpret/plan/execute/evaluate) con duración, cada llamada upstream (request/response con latencia, tokens, tool_calls), delegación de tools, errores y fin del request. Para auditar un request: `grep <trace_id> logs/evolve-proxy-*.log`.
- Los loggers se crean por request con `createLogger('http').traced(traceId)`; el logger viaja con las opciones de llamada (`ProviderCallOptions.logger`) para que hasta un provider singleton loguee bajo el trace correcto.
- El logger NUNCA crashea un request: cualquier fallo de escritura se descarta.
- **Consola en vivo**: cada línea se espeja también a stdout (error/warn a stderr) cuando `CONSOLE_LOG=true` (por defecto; `CONSOLE_LOG=false` para silenciar). Un hook `onRequest` loguea **toda** conexión entrante al instante: `incoming: <ip> <METHOD> <endpoint> (HTTP/<versión>)` con su `trace_id`.
- **Línea de resultado coloreada** (solo consola, el archivo de log queda plano): un hook `onResponse` emite para cada respuesta `requestResult()` → `<ip> <METHOD> <endpoint> (HTTP/x.x) stream=<yes|no|-> → <status> (<ms>)`, con el estado coloreado (2xx verde, 408/429 amarillo, 4xx/5xx rojo) y el tipo de streaming (cyan=yes, magenta=no). El color ANSI se emite cuando la consola es TTY o `FORCE_COLOR=1` (se respeta `NO_COLOR`); `stream=yes/no` solo aparece en `/v1/chat/completions` (se marca en el handler al conocer el body).
- **Interceptor de capturas** (depuración), en dos capas, controlado por `CAPTURE_REQUESTS` (default `true`) y `CAPTURE_DIR` (default `./captures`):
  - **Entrante**: cada request a `/v1/chat/completions` → `app/captures/<UTC-timestamp>_<traceId>.json` (body íntegro: messages + tools, headers con auth redactada, resumen con nº de messages/tools, chars y estimación de tokens).
  - **Upstream**: cada llamada a la API del modelo → `app/captures/upstream/<UTC-timestamp>_<traceId>_{request,response,error}.json` (request: messages + tools + opciones tal cual se envían; response: content/reasoning/tool_calls/usage/duración; error: mensaje parcial + contenido acumulado). Todas comparten el `traceId` de la petición, así `grep <traceId>` o listar la familia de archivos da la cadena completa cliente → proxy → upstream.
- **Error handler global**: cualquier error (JSON malformado —muere en el parser, antes de `preValidation`—, 400 de validación, 500 inesperado) se loguea con su `trace_id` y responde con el body estándar de Fastify. No hay 4xx/5xx silenciosos.
- **Fail-fast en auto-healing**: los errores deterministas upstream (`ContextWindowExceeded`, auth, 400/401/403/404, `BadRequest`, …) NO queman el presupuesto de reintentos — se falla en el 1.º intento (`isDeterministicUpstreamError`).

## Stop propagation (interrupción del cliente)

Cuando el cliente interrumpe la conexión o pide al modelo que se detenga (opencode corta el stream HTTP en ambos casos), el proxy: (1) **cancela la llamada upstream en curso** — el `fetch` del SDK muere, no se generan tokens más para un cliente muerto — y (2) **detiene el AgentLoop** en el siguiente checkpoint sin reintentos.

- **Mecanismo**: un `AbortController` por request en `routes.ts`; un listener en `reply.raw` `'close'` (con guard `writableEnded`) lo aborta. La señal viaja `LoopOptions.abort_signal` → `ProviderCallOptions.abort_signal` → `abortSignal` del `doGenerate`/`doStream` del SDK.
- **`isAbortError()`** (`provider/types.ts`, duck-typed) clasifica los fallos; el SDK envuelve aborts en mensajes opacos (`Failed to process successful response`), por lo que la detección se apoya también en la bandera `signal.aborted`.
- Los aborts NO reintentan: `withAutoHealingRetry` recibe `abortSignal` y falla en el 1.º intento; la decisión final es `error`.
- La desconexión silenciosa del sink (comportamiento SC-023 original) sigue rompiendo el loop con `decision='continue'`; el abort explícito registra `decision='error'`.

## Delegación de fases a subagentes (FASE 6)

Además del bucle inline, el proxy puede **delegar las fases planificar/ejecutar/evaluar al cliente** vía tool call de spawn estándar (wire 100% OpenAI; ver [A-006](./docs/adr/a-006-subagent-phase-delegation.md)):

- **Tri-partición en `routes.ts`** (request con `tools` + `x-session-id`): (1) el prompt lleva un **envelope** `{"phase","parent_session_id","agent_id"}` en su línea 1 → es un subagente (1.ª petición = el proxy corre ESA fase con `orchestrator.runSubagentPhase()`; continuaciones = petición normal y su último `content` actualiza el resultado de la fase — *last content wins*). (2) La sesión propia lleva `loopState` → **parent resume** (sincrónico, sin upstream call): consume el resultado, emite el siguiente spawn o la respuesta final. (3) Petición nueva sin sesión guardada → `orchestrator.start()` = mapeo + interpret + spawn(planify).
- **Fase de mapeo** (`subagent-mapper.ts`): un upstream call (máx. 2) le pide al modelo que elija entre las `tools` del cliente la herramienta que crea subagentes y mapee sus argumentos (title/type/prompt). Tools en formato **compacto** (nombre + descripción ≤300 chars + args con enums) y `max_tokens: 8192` (los modelos de razonamiento gastan el presupuesto en thinking; con 512 fallaba con `finish_reason:"length"`).
- **`agent_id` NUNCA viaja como argumento del tool call** — solo dentro del envelope del prompt. El mapeo produce únicamente `title`/`type`/`prompt`.
- **Un solo tipo de subagente** lo elige el modelo en la fase de mapeo (`type_id`, el de propósito general) y se usa para **todas** las fases; el mapeo también devuelve **todos los tipos disponibles** (`availableTypes`, más genérico primero) para **failover**: **cada fallo** (una petición de parent-resume sin resultado de fase) reintenta **de inmediato con el siguiente tipo** (round-robin por `availableTypes`, con wrap-around) y `agent_id` nuevo; con un solo tipo disponible, re-emite el mismo spawn de forma estable (mismo `agent_id`). El tipo que por fin produce resultado queda **fijado** para la sesión. El tipo elegido **siempre existe**: validado contra la lista del propio modelo (`parseSpawnSpec`) y contra el `enum` real del argumento type del schema del cliente (mapper).
- **Drift de la lista de tipos entre peticiones:** el cliente puede cambiar los tipos que ofrece (o renombrar la herramienta de spawn) entre requests. `detectTypeDrift()` lo detecta de forma **determinista, sin el modelo** leyendo el `enum` del argumento type en el esquema entrante, solo en la rama de parent-resume (nunca durante una fase subagente). Drift = herramienta ausente, o `enum` real donde ninguno de los tipos mapeados sigue existiendo → se re-ejecuta el mapeo y se actualiza `spec`/`activeTypeId`. Sin `enum` (free-form) no es detectable sin preguntar al modelo → no se re-mapea. Si el re-mapeo falla, se conserva el spec anterior.
- **Separación de listas de tools padre/subagente:** los requests del padre y del subagente llevan **listas de tools distintas** (mismo flujo de sesión, session ids propios). Regla (confirmada con el usuario, FASE 6): `state.tools`/`state.tool_choice` son **inmutables tras la primera petición del padre** — ninguna rama (ni parent-resume, ni las ramas del subagente) las reescribe; y la lista del subagente **no se guarda en ninguna parte** (`runSubagentPhase` la recibe localmente vía `body.tools`). Por tanto el drift se evalúa **solo** con la petición entrante del padre (rama parent-resume); los cambios en la lista del subagente entre sus propias peticiones no se detectan ni actúan sobre el estado (sin referencia guardada, no hay nada contra qué comparar) — ver [A-006](./docs/adr/a-006-subagent-phase-delegation.md).
- **Fail-safe**: sin herramienta de spawn o mapeo inválido → `start()` devuelve `null` → fall-through al bucle inline clásico (`AgentLoop.run()` intacto; `SseWriter` solo se crea tras un mapeo exitoso, porque su constructor tiene side effects — patrón `makeSink` factory).
- **Endurecimiento**: si en un parent resume el resultado de la fase pendiente aún no llegó (el cliente bloqueó o no corrió el subagente), se **re-emite el mismo spawn** (mismo `agent_id`) sin avanzar rondas — un subagente bloqueado nunca gira el bucle con salidas vacías.
- **Estado serializable**: `LoopStateData` (`loop-state.ts`) vive en la sesión del padre (`SessionStore`, TTL 30 min) junto con `subagentBindings` (subagent-session → {parent, agent_id, phase}).
- **Prompts compartidos**: `phase-prompts.ts` es la única fuente de los prompts de fase y la shaping de mensajes (R1: roles `assistant` preservados; fallback *rendered* ante rechazo 4xx, sticky). Bucle inline y orquestador usan los mismos builders, por lo que los routers de los stubs y el live coinciden.
- **Verificado live end-to-end** con `opencode --pure` (89 tools, `llama_cpp/default`): mapeo `task` + `type="sme" available=[sme,architect,explorer,coder,designer,docs,reviewer,critic,test_engineer]` (los 9 types reales enumerados), el cliente **ejecuta de verdad** los subagentes `planify (round 1)` → `execute (round 1)` → `evaluate (round 1)` (cada fase ~48 s de LLM a través del proxy) y el orquestador cierra con `decision=complete round=1 upstream_calls=5`, devolviendo la respuesta final a opencode. Con el plugin `opencode-swarm` los dispatches quedan bloqueados en el knowledge-gate del plugin (limitación de entorno); el fail-safe (re-emisión estable, failover, TTL) está verificado y cubierto por tests.
- **Descripciones del mapeo:** las tools *spawn-like* (nombre matchea `task|spawn|subagent|agent|delegate|worker|launch`) conservan la descripción completa (cap 4000 chars) en el prompt compacto — la lista de types válidos suele vivir en el tramo final de la descripción, y truncarla a 300 chars hacía que el modelo fabricara `type="default"` (rechazado por el cliente en runtime). El resto de tools sigue en 300 chars.
- **`bodyLimit`**: 16 MB (Fastify, `routes.ts`) — clientes con 89–218 tool schemas envían cuerpos de ~1 MB y el default de 1 MB daba 413 intermitentes.

## Principios para trabajar en este proyecto

1. **Validation primero.** Todo request debe validarse contra un schema JSON antes de procesarse.
2. **Minimalismo.** No añadir dependencias sin justificar el valor real que aportan.
3. **Documentar decisiones arquitecturales.** Si se toman decisiones importantes, crear un archivo `docs/adr/` correspondiente.

## Documentación relacionada

| Recurso | Estado |
| --------- | -------- |
| [README.md](./README.md) | Documentación completa del proxy (arquitectura, streaming, FASE 6, configuración) |
| [LICENSE.md](./LICENSE.md) | Apache 2.0 |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | No existe |
| [docs/adr/index.md](./docs/adr/index.md) | Índice de decisiones arquitecturales (A-001…A-008) |
| [plans/subagent-phase-delegation.md](./plans/subagent-phase-delegation.md) | Plan FASE 6 — Delegación de fases a subagentes |
