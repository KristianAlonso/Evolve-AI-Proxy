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

- **Cada operación deja una línea**: request recibido, resolución de modelo, configuración del loop, cada fase del agent loop (interpret/plan/execute/evaluate/condense) con duración, cada llamada upstream (request/response con latencia, tokens, tool_calls), delegación de tools, errores y fin del request. Para auditar un request: `grep <trace_id> logs/evolve-proxy-*.log`.
- Los loggers se crean por request con `createLogger('http').traced(traceId)`; el logger viaja con las opciones de llamada (`ProviderCallOptions.logger`) para que hasta un provider singleton loguee bajo el trace correcto.
- El logger NUNCA crashea un request: cualquier fallo de escritura se descarta.
- **Consola en vivo**: cada línea se espeja también a stdout (error/warn a stderr) cuando `CONSOLE_LOG=true` (por defecto; `CONSOLE_LOG=false` para silenciar). Un hook `onRequest` loguea **toda** conexión entrante al instante: `incoming: <ip> <METHOD> <url>` con su `trace_id`.

## Principios para trabajar en este proyecto

1. **Validation primero.** Todo request debe validarse contra un schema JSON antes de procesarse.
2. **Minimalismo.** No añadir dependencias sin justificar el valor real que aportan.
3. **Documentar decisiones arquitecturales.** Si se toman decisiones importantes, crear un archivo `docs/adr/` correspondiente.

## Documentación relacionada

| Recurso | Estado |
| --------- | -------- |
| [README.md](./README.md) | Básico — solo nombre del proyecto |
| [LICENSE.md](./LICENSE.md) | Apache 2.0 |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | No existe |
| [docs/adr/index.md](./docs/adr/index.md) | **Nuevo** — Índice de decisiones arquitecturales |
