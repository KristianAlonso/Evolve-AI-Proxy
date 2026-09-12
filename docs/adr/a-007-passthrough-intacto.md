# ADR A-007: Passthrough-intacto de la petición del cliente

**Estado:** Aceptado
**Fecha:** 2026-09-12

## Contexto

El proxy reescribe el cuerpo de la petición al reenviarla al upstream: reconstruye
`messages` (injecciones de fase del bucle agéntico) y reemplaza `model` (alias).
Antes de esta decisión, la reescritura era **aditiva por defecto**:

- El proxy **inventaba valores** en campos que el cliente no envió: el mapper forzaba
  `max_tokens: 8192`, el interpretador `max_tokens: 512`, el evaluador `max_tokens: 128`.
- Solo reenviaba dos campos del cliente (`max_tokens`, `temperature`) y descargaba el
  resto (`top_p`, `seed`, `top_k`, `stop`, `logprobs`, `logit_bias`, `response_format`,
  `user`, `metadata`, `service_tier`, `parallel_tool_calls`, `reasoning_effort`,
  `stream_options`, …) directamente al upstream.

Esto rompía el contrato de compatibilidad con la OpenAI API: el proxy **NO** se comporta
como el OpenAI original, y cada request del cliente era modificado de formas impredecibles.

### El principio

El proxy debe enviar al upstream la petición **exactamente como llegó**, con la única
excepción de `messages` (que el proxy reconstruye por diseño, inyectando contextos de
fase) y `model` (alias). El resto de la petición debe **conservarse tal cual**.
Nunca inventar valores: lo que el cliente no envió, el proxy no lo inventa.

## Decisión

**ADR A-007 — Passthrough-intacto.** El proxy reenvía al upstream la petición del
cliente con los siguientes cambios, y solo estos:

| Campo | Comportamiento |
|-------|----------------|
| `messages` | Reconstruido por el proxy (inyección de contexto por fase) |
| `model` | Resuelto de alias al nombre upstream real |
| Resto del body | **Passthrough-intacto**: todo campo no-reservado se reenvía verbatim |

### Implementación

1. **Cosecha (`routes.ts` → `buildPassthrough(body)`):** el handler copia todos los
   campos del body **salvo** `RESERVED_BODY_KEYS`
   (`model`, `messages`, `stream`, `tools`, `tool_choice`, `max_rounds`,
   `max_retries`, `doom_loop_threshold`, `context_window_size`) en un objeto
   `passthrough: Record<string, unknown>` que viaja por todo el pipeline
   (loop / orchestrator / interpret / planify / execute / evaluate / mapper).

2. **Reenvío (`openai-compatible-provider.ts` → `buildForwardOptions`):** dos canales,
   ambos sin inventar nada:

   - **Campos estándar (SDK v4):** los que el SDK `@ai-sdk/openai-compatible` conoce y
     sabe serializar a nombres OpenAI se mapean a opciones v4:
     `temperature`, `top_p` → `topP`, `max_tokens` → `maxOutputTokens`,
     `seed`, `stop` → `stopSequences`, `frequency_penalty`, `presence_penalty`.
   - **`reasoning_effort` → `reasoning` (custom-reasoning string):** el SDK escribe
     `reasoning_effort` en el body DESPUÉS de su spread de `providerOptions` (con
     `undefined` si la opción v4 `reasoning` no está seteada), por lo que el valor raw
     sería clobbered. Un string en `reasoning` es el "custom reasoning payload" del SDK
     y se pasa verbatim al campo `reasoning_effort` del body.
   - **Todo lo demás:** va a `providerOptions['evolve_upstream']`; el SDK los hace
     `Object.fromEntries` y los **esparce verbatim** en el cuerpo del request.

   `PROVIDER_NAME = 'evolve_upstream'` es el nombre estable del provider en el SDK
   (evita el host-derivation frágil de la URL con puntos, que mangleaba
   `providerOptionsName` a `'26'`).

3. **Eliminación de valores inventados:** se remueven los `max_tokens` forzados
   (`8192` mapper, `512` interpreter, `128` evaluator). Si el cliente no envía
   `max_tokens`, el upstream recibe **nada** (su default — exactamente lo que haría el
   OpenAI original).

4. **Nunca se reenvía:** `stream` (lo gestiona el SDK: `doGenerate` la omite, `doStream`
   la añade), `messages`/`tools`/`tool_choice` (viajan por su propio path transformado),
   y los campos de control del proxy (`max_rounds`, etc.).

### Verificación

- **Unit (13 tests nuevos):** el fake SDK client captura las opciones v4 recibidas y
  asierte: campos estándar mapeados; campos exóticos (`top_k`, `logprobs`,
  `logit_bias`, `stream_options`, `user`, `metadata`, `service_tier`,
  `parallel_tool_calls`, `max_completion_tokens`) intactos en
  `providerOptions.evolve_upstream`; campos reservados NUNCA reenviados; sin passthrough
  → sin opciones inventadas; `reasoning_effort` → `reasoning` v4.
- **Wire (dump upstream, `tmp-oc/dump-upstream.ts`):** un upstream simulado graba los
  cuerpos HTTP crudos. Se envió una petición con 16 campos; **todos** llegaron verbatim
  en el body del upstream (14 en llamadas stream, +`stream_options` en la buffered).
  Únicas ausencias: `stream` (la añade el SDK en llamadas stream) y `stream_options`
  en llamadas stream (el SDK fuerza `undefined` porque `includeUsage` no está
  configurado — ver "Límites").
- **Suite:** 93/93 tests en verde (incl. integración live contra la gateway LiteLLM).
- **Live:** petición real con `temperature/top_p/seed/max_tokens/user/metadata` →
  capturas upstream confirman el passthrough verbatim en las 3 llamadas del bucle.

## Consecuencias

### Positivas

- **Compatibilidad OpenAI real.** El proxy se comporta como el OpenAI original: lo que
  el cliente envía es lo que el upstream recibe.
- **Determinismo.** Sin valores inventados: sin `max_tokens` fantasma, sin defaults
  ocultos que enmascararan el comportamiento del upstream.
- **Extensibilidad.** Nuevos campos OpenAI (`reasoning_effort`, `service_tier`, …)
  funcionan sin tocar el proxy.

### Negativas / Límites

- **El upstream ve `messages` con las inyecciones del proxy** (ya documentado — es el
  núcleo del bucle agéntico, no de esta ADR).
- **Llamadas stream:** `stream_options` del cliente NO llega (el SDK la fuerza a
  `undefined` en `doStream` porque `includeUsage` no está configurado). Aceptable:
  nuestro protocolo SSE al cliente es propio (`SseWriter`), no depende de la
  `stream_options` upstream. Si se necesita, se configura `includeUsage: true` en el
  cliente SDK.
- **El SDK serializa `top_k` como warning "unsupported"** (no la mapea), pero el spread
  raw la preserva en el body — el upstream la recibe igual.
- **Responsabilidad del cliente:** si el cliente envía un campo que el upstream rechaza,
  el upstream rechaza. Es el comportamiento correcto (no ocultamos errores de la API
  real), pero significa que peticiones "válidas" contra el proxy pueden fallar en el
  upstream por campos que el OpenAI original no soportaría.

## Alternativas consideradas

1. **Mantener solo los 2 campos (`max_tokens`, `temperature`)** — Rechazado: descargaba
   ~15 campos OpenAI estándar; seguía rompiendo compatibilidad.
2. **Lista blanca explícita de campos permitidos** — Rechazado: cada campo OpenAI nuevo
   requeriría actualizar el proxy (frágil, contraproducente).
3. **Lista negra de campos reservados (la elegida)** — Correcta: la excepción es finita
   y estable (los 9 campos reservados), la regla por defecto es "reenviar".
