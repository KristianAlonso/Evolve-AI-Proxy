// Model + context-window resolution (SC-016 / SC-021 / SC-022 / SC-024).
//
// The incoming `model` comes from the request body, and only from `body.model` — there is no
// header-based override. It still stands alone for every client, so `resolveUpstreamModel()`
// maps it against `/v1/models`. The context-window size, when absent on the request, is
// consulted from the API that serves the model rather than guessed here.

import env from '../infrastructure/config.js';
import type { ChatProvider, UpstreamModel } from '../domain/provider/types.js';
import type { ProxyRequest } from '../domain/types.js';

/**
 * Resolve an incoming model id to a concrete upstream model, so the loop never forwards an id that
 * LiteLLM does not recognize — opencode's alias (`evolve_proxy/default`) and any unknown id used to
 * fail every step before the first call (`upstream_calls:0`, decision `error`).
 *
 * Resolution order per SC-016/SC-024 intent and config `AUTO_RESOLVE_MODEL`:
 *   1) if the request names an id that exists on `/v1/models`, pass it straight through (never guess);
 *   2) otherwise, when auto-resolve is enabled, pick the first upstream chat/text model — authoritative
 *      to whatever the provider actually serves;
 *   3) terminal fallback to config `FALLBACK_MODEL`.
 *
 * `models` is the single `/v1/models` fetch already threaded in from the caller — passing the array
 * here (rather than re-calling `provider.listModels()`) keeps every lookup on one cold round-trip per
 * request. Never throws: it reads a cached list and falls back gracefully instead of breaking work.
 */
export async function resolveUpstreamModel(
  bodyModel: string,
  models: UpstreamModel[],
): Promise<string> {
  const concrete = (bodyModel ?? '').trim();

  // Prefer an existing upstream id verbatim — never guess when the user named a real one.
  if (concrete) {
    if (models.some((m) => m.id === concrete)) return concrete;
  }

  // Empty listing = the /v1/models fetch failed, NOT proof the model is unknown. The config
  // fallback lives on the same (dead) gateway, so mapping to it only misleads logs and wastes
  // the fetch timeout; forward the requested id verbatim and let the upstream answer.
  if (concrete && models.length === 0) return concrete;

  if (!env.AUTO_RESOLVE_MODEL) return env.FALLBACK_MODEL;

  for (const m of models) {
    const mode = String(m.mode ?? '');
    if (/chat|text/i.test(mode)) return m.id;
  }
  return env.FALLBACK_MODEL;
}

/** Log-friendly summary of how the incoming model id resolved (exact / auto-resolve / fallback). */
export function describeModelResolution(bodyModel: string, concrete: string, models: UpstreamModel[]): string {
  if (concrete === bodyModel) return 'exact';
  if (models.some((m) => m.id === concrete)) return 'auto-resolve';
  return 'fallback';
}

/**
 * Resolve the upstream context-window size for this request (SC-021 / SC-022).
 *
 * Resolution order, per product rule — "the maximum window must be consulted from the API that
 * serves the model" ONLY when the request does not declare one:
 *   1) an explicit `body.context_window_size` on the request (no upstream call);
 *   2) otherwise `/v1/models` advertised `max_input_tokens` for this model — the provider serving
 *      it is authoritative;
 *   3) unlimited (`0`) when neither is available: the loop never stalls over missing metadata, and
 *      a zero window disables proxy-side condensation so the upstream enforces its own real cap —
 *      whose error propagates to the client exactly as designed.
 *
 * Never throws: a hiccup on `/v1/models` falls through rather than blocking real work.
 */
export async function resolveContextWindow(
  models: UpstreamModel[],
  body: Partial<ProxyRequest>,
): Promise<number> {
  // (1) Honour a size explicitly declared on the request — short-circuit BEFORE any upstream call.
  const explicit = body.context_window_size;
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit >= 0) {
    return explicit;
  }

  // (2) Otherwise ask the API that serves the model — authoritative per-model cap if advertised.
  const fromUpstream = await resolveSizeFromProvider(models, (body.model ?? '').trim());
  if (fromUpstream !== undefined && fromUpstream >= 0) return fromUpstream;

  // (3) Terminal fallback: unlimited window. Proxy-side condensation stays off; the upstream caps it.
  return 0;
}

/** Read a positive context-window size from `/v1/models` (undefined when absent/invalid). */
export async function resolveSizeFromProvider(
  models: UpstreamModel[],
  model: string,
): Promise<number | undefined> {
  // Prefer the exact-model entry so a per-model cap wins over whatever else is listed.
  let entry = models.find((m) => m.id === model);
  if (!entry) {
    const candidates = models.filter((m) => !m.mode || /chat|text/.test(String(m.mode)));
    entry = candidates[0];
  }

  const n = entry?.max_input_tokens ?? undefined;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Per-request model metadata resolver. Memoizes the upstream `/v1/models` fetch so that model
 * alias resolution AND the context-window lookup share ONE cold round-trip per request (the
 * provider's own cache already avoids re-fetching, but an empty-list retry path must not double
 * the request-scoped bookkeeping either).
 */
export class ModelResolver {
  private modelsPromise: Promise<UpstreamModel[]> | null = null;

  constructor(private readonly provider: ChatProvider) {}

  /** The `/v1/models` listing, fetched at most once per resolver instance. */
  models(): Promise<UpstreamModel[]> {
    if (!this.modelsPromise) {
      this.modelsPromise = (async () => {
        try {
          const list = await this.provider.listModels();
          return Array.isArray(list) ? list : [];
        } catch {
          /* metadata unavailable — an empty list defers cleanly to body/default handling */
          return [];
        }
      })();
    }
    return this.modelsPromise;
  }

  /** Map the incoming `body.model` to a concrete upstream model id. */
  async resolveModel(bodyModel: string): Promise<string> {
    return resolveUpstreamModel(bodyModel, await this.models());
  }

  /** Log summary of the resolution (exact / auto-resolve / fallback). */
  async describe(bodyModel: string, concrete: string): Promise<string> {
    return describeModelResolution(bodyModel, concrete, await this.models());
  }

  /** The context window for this request (explicit body > /v1/models > 0 = upstream decides). */
  async contextWindow(body: Partial<ProxyRequest>): Promise<number> {
    return resolveContextWindow(await this.models(), body);
  }
}
