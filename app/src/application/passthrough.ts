// ADR A-007 (passthrough-intacto) + ADR A-010 (OpenAI cache identifiers).
//
// The client request's body, verbatim, minus the fields the proxy itself transforms
// (`messages` — rebuilt per phase, `model` — alias-resolved, `stream` — SDK-managed,
// `tools`/`tool_choice` — converted to the SDK shape) and the evolve proxy controls
// (proxy directives, not model API parameters). Every surviving field is forwarded to the
// upstream unchanged on every call the proxy makes for this request. `undefined` values are
// dropped (they are absent from the wire anyway).

/** Body fields the proxy transforms itself — never forwarded as client passthrough. */
const RESERVED_BODY_KEYS: ReadonlySet<string> = new Set([
  'model',
  'messages',
  'stream',
  'tools',
  'tool_choice',
  'max_rounds',
  'max_retries',
  'doom_loop_threshold',
  'context_window_size',
]);

/**
 * ADR A-010 — cache identifiers. The OPENAI-compatible cache identifiers are `prompt_cache_key`
 * (cache group for prompt caching) and `prompt_cache_retention` (time-to-keep the cached
 * prefix). Clients may also send vendor-specific aliases (OpenCode ships `promptCacheKey` /
 * `set_cache_key` — the same value, camel/snake variants, never the OpenAI field name): the
 * proxy normalizes every alias to the single standard `prompt_cache_key` so upstream servers
 * that key their prompt cache on the field (llama.cpp, LiteLLM) actually see it. When the
 * client provides no identifier at all, the proxy synthesizes one from the conversation's
 * affinity header (`x-session-id`) so that a whole conversation — every loop phase, every
 * subagent phase, every resume — shares one cache group upstream. Without a session id there
 * is no stable conversation identity, so no key is synthesized (A-007: never invent values).
 */
const CACHE_IDENTITY_KEYS: ReadonlySet<string> = new Set(['prompt_cache_key', 'promptCacheKey', 'set_cache_key']);

function clientCacheKey(body: Record<string, unknown>): string | undefined {
  for (const key of ['prompt_cache_key', 'promptCacheKey', 'set_cache_key']) {
    const v = (body ?? {})[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

/**
 * Build the passthrough map forwarded to EVERY upstream call of this request. Single common
 * point of the pass-through — parent, subagent phases, the mapper, phase calls and pure
 * passthrough all receive this same object (ADR A-010: verified in the upstream captures).
 */
export function buildPassthrough(body: Record<string, unknown>, sessionId?: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body ?? {})) {
    if (RESERVED_BODY_KEYS.has(key) || CACHE_IDENTITY_KEYS.has(key) || value === undefined) continue;
    out[key] = value;
  }
  const cacheKey = clientCacheKey(body ?? {}) ?? (sessionId ? `evolve_${sessionId}` : undefined);
  if (cacheKey) out.prompt_cache_key = cacheKey;
  return out;
}
