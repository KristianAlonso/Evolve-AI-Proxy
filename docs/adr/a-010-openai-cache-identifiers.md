# A-010: Identificadores de caché compatibles con OpenAI (`prompt_cache_key`)

**Estado:** Aceptada
**Fecha:** 2026-09-13

## Contexto

El identificador de caché de la API compatible con OpenAI son los campos `prompt_cache_key`
(grupo de caché del prompt) y `prompt_cache_retention` (TTL del prefijo cachado). Varios
upstreams los usan para agrupar/reutilizar el prompt cache entre requests (llama.cpp para su
prompt cache, LiteLLM para routing de afinidad de prefill).

El cliente OpenCode **pide** la función (`setCacheKey: true`, `supportsPromptCacheKey: true`,
`cache_prompt: true`) pero envía su campo propio `promptCacheKey`/`set_cache_key` (valor = su
`x-session-id`) — **nunca** el nombre estándar `prompt_cache_key`. Capturas en vivo:

```json
{ "promptCacheKey": "ses_...", "set_cache_key": true, "setCacheKey": true,
  "supportsPromptCacheKey": true, "cache_prompt": true, "prompt_cache_retention": "2h" }
```

Resultado: ningún upstream ve un identificador de caché en formato OpenAI, y los requests
secundarios de una conversación (cada fase del bucle, cada fase de subagente, cada resume)
no comparten un grupo de caché explícito.

## Decisión

Normalización en el único punto común — `buildPassthrough` (`src/application/passthrough.ts`), cuya salida
viaja en `ProviderCallOptions.passthrough` a **toda** llamada upstream (fases del bucle,
orquestador, mapper, passthroughs):

1. **Aliases → estándar**: `prompt_cache_key` | `promptCacheKey` | `set_cache_key` se
   normalizan al campo `prompt_cache_key`; los alias **no** se reenvían crudos.
2. **El cliente manda**: cualquier valor explícito del cliente gana sobre el síntesis
   (y el nombre estándar OpenAI gana sobre los alias).
3. **Síntesis mínima**: sin valor del cliente, el proxy sintetiza
   `prompt_cache_key = "evolve_<x-session-id>"` — una identidad estable por conversación,
   así TODAS las fases de TODAS las peticiones de la conversación comparten un mismo grupo
   de caché upstream.
4. **Sin sesión y sin valor del cliente → no se inventa nada** (consigna A-007).
5. `prompt_cache_retention` (y el resto de campos de caché) ya fluía verbatim por el
   passthrough y se mantiene intacto.

## Alternativas Consideradas

| Alternativa | Ventajas | Desventajas | Por qué no se eligió |
|-------------|----------|-------------|---------------------|
| No tocar nada (A-007 verbatim) | Cero lógica nueva | El identificador del cliente nunca llega en formato OpenAI; sin grupo de caché explícito | Es exactamente el problema a resolver |
| Llave derivada de contenido (hash del system+tools) | Reutilización de prefijo entre sesiones | Rompe la semántica OpenAI del campo (lo pone el cliente); inesperado para upstreams | Se prefiere la semántica estándar; el prefijo entre sesiones ya se aprovecha por matching de contenido en llama.cpp |
| Campo nuevo `cache_key` en `ProviderCallOptions` | Explícito | Duplifica el canal passthrough ya existente | La normalización en `buildPassthrough` cubre los 4 caminos sin new threading |

## Consecuencias

- Upstreams que lean `prompt_cache_key` (llama.cpp, LiteLLM) reciben siempre el campo
  estándar cuando hay una conversación identificable (header `x-session-id`) — con o sin
  ayuda del cliente.
- Test: `src/test/cache-key.test.ts` (normalización, precedencia, síntesis, nada inventado,
  retention intacto).
