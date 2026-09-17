# A-012: SSE commit perezoso y errores de upstream sin crash (502)

**Estado:** Aceptada
**Fecha:** 2026-09-16

## Contexto

Cuando el upstream cae (`ECONNREFUSED`, p. ej. LiteLLM apagado) y la petición es
`stream=true`, el proceso **entero** moría:

1. `SseWriter` escribía **eager** en el constructor: `reply.type('text/event-stream')` +
   `reply.header(...)` + el comentario `: connected`. Eso **committeaba** la línea de estado
   200 y el content-type antes de saber si el upstream estaba vivo.
2. La llamada upstream fallaba con `ECONNREFUSED` **antes** de emitir ningún chunk.
3. El error subía al error-handler global de Fastify, que hacía `reply.status(500).send(...)`.
4. Al tener los headers ya enviados, `writeHead(500)` lanzaba `ERR_HTTP_HEADERS_SENT` — una
   excepción **uncaught** que crasheaba el proceso Node (el cliente nunca recibía respuesta).

Además, la resolución de modelo mapeaba el `model` pedido al `FALLBACK_MODEL` de config
cuando el fetch de `/v1/models` fallaba — pero el fallback vive en el **mismo** gateway
(caído), así que solo engañaba los logs y quemaba el timeout del fetch.

## Decisión

1. **`SseWriter` commit perezoso.** El constructor ya NO tiene efectos colaterales: no fija
   el content-type, no escribe headers, no emite el frame `: connected`. Todo se **commitea en
   el PRIMER frame real** (`commitHeaders()` dentro de `safeWrite`, una sola vez). Así una
   fallback antes del primer byte todavía puede responder un JSON de error limpio.
   - El frame de keepalive `: connected` se elimina (ya no hay necesidad: no se emite hasta que
     hay un frame real, y los clientes OpenAI-compatible solo necesitan los `data:` chunks).

2. **Fallo de upstream = `502` limpio, nunca crash.** Todo el camino que responde un stream
   (`servePurePassthrough`, `handleStream`, `handleSubagentPhase`) envuelve la llamada upstream
   en try/catch y delega en `terminateStreamWithError()`:
   - **Headers aún NO enviados** (falló antes del primer byte, el caso `ECONNREFUSED`):
     responde **JSON 502** `{ error: { message, type: 'upstream_error', detail, trace_id } }` —
     exactamente lo que un cliente OpenAI-compatible espera de un `POST` fallido.
   - **Headers YA enviados** (falló a mitad de stream, ya hay chunks en el aire): ya no se puede
     expresar un código de estado; se termina **in-band** con un frame de error + `data: [DONE]`
     + EOF, para que el cliente vea un stream que terminó con error, no un response corrupto
     o colgado.
   - Si el cliente ya cortó (`abort_signal` / disconnect), no se intenta nada.

3. **Error-handler global a prueba de crash.** Si `reply.raw.headersSent` es true, el handler
   ya no intenta escribir un estado: cierra el stream con `reply.raw.end()` y devuelve. Nadie
   vuelve a lanzar `ERR_HTTP_HEADERS_SENT` desde el handler.

4. **Modelo verbatim cuando la lista de modelos falla.** En `resolveUpstreamModel`, si
   `models.length === 0` (el fetch de `/v1/models` falló — no es prueba de que el modelo no
   existe) y el body trae un `model` concreto, se reenvía **verbatim**. El fallback de config
   queda solo para el caso de lista vacía **y** sin model explícito.

## Alternativas Consideradas

| Alternativa | Ventajas | Desventajas | Por qué no se eligió |
|-------------|----------|-------------|---------------------|
| Solo envolver el error-handler en try/catch | Mínimo | El cliente ve un stream truncado (EOF sin `finish_reason`), sin código de error explícito; la mitad del fallo (el fallback erróneo) queda sin arreglar | No da un error limpio al cliente; el crash se "silencia" en vez de resolverse |
| Mantener `: connected` eager + `reply.hijack()` antes del error-handler | Respuesta 500 posible | `hijack()` desactiva el ciclo de vida de Fastify; más complejo y frágil; sigue sin dar JSON 502 en el caso pre-primer-byte | El commit perezoso resuelve el mismo problema con menos superficie |
| Reintentar el fetch de `/v1/models` antes de mapear | Model más "correcto" | Añade latencia a TODA petición con gateway caído; no ayuda porque el gateway caído responde igual al chat | El verbatim es más honesto y más rápido cuando el upstream está caído |

## Consecuencias

- Con el upstream caído, una petición `stream:true` devuelve **`502` JSON** y el proceso
  sigue sirviendo (`/health` sigue ok). Sin `ERR_HTTP_HEADERS_SENT`, sin crash.
- Con el upstream caído, una petición `stream:false` (passthrough) devuelve **`502` JSON** con
  el detalle del error upstream.
- El `model` pedido se reenvía tal cual cuando `/v1/models` no responde; el log de resolución
  ya no miente (`"llama_cpp/default" -> "llama_cpp/default" (exact)` en vez de `-> gemini/... (fallback)`).
- El patrón `makeSink` (factory del orquestador) sigue vigente: crear el `SseWriter` ahora
  **no** tiene efectos colaterales, pero el factory aún acota cuándo se enlaza el sink al reply.
- Tests: `src/test/no-tools-passthrough.test.ts` (bloque "upstream down (dead gateway)"):
  stream → 502 JSON + modelo verbatim; non-stream → 502 JSON con detalle `ECONNREFUSED`.
  `src/test/integration.live.test.ts` actualizado a la semántica A-009 (`meta.passthrough`).
