// ADR A-010 — OpenAI-compatible cache identifiers.
//
// Clients ship cache identifiers in non-standard shapes: OpenCode sends `promptCacheKey` /
// `set_cache_key` (never the OpenAI field name `prompt_cache_key`), so upstream servers that
// key their prompt cache on the OpenAI field (llama.cpp, LiteLLM) never saw a cache identity.
// Contract under test (single choke point: `buildPassthrough`, every upstream call receives
// it through `options.passthrough`):
//   1. any client alias (`prompt_cache_key` | `promptCacheKey` | `set_cache_key`) is
//      normalized to the standard `prompt_cache_key` — aliases are NOT forwarded raw;
//   2. client-provided values win (explicit `prompt_cache_key` beats the aliases, all beat
//      the synthesized key);
//   3. when the client provides nothing, the key is synthesized from the conversation's
//      affinity header: `evolve_<x-session-id>`;
//   4. no session id AND no client value -> no key is invented (A-007).

import { describe, it, expect } from 'vitest';
import { createApp } from '../presentation/app.js';
import { SessionStore } from '../domain/session-store.js';
import type { ChatProvider, ProviderCallOptions, UpstreamModel } from '../domain/provider/types.js';
import type { NormalizedResult, UpstreamMessage } from '../domain/types.js';

const BODY = { model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }] };

/** A provider that records the ProviderCallOptions of every upstream call. */
function captureProvider() {
  const captured: ProviderCallOptions[] = [];
  const provider: ChatProvider = {
    listModels: async () => [] as UpstreamModel[],
    complete: (model: string | null, _messages: UpstreamMessage[], options?: ProviderCallOptions) => {
      captured.push(options ?? {});
      return Promise.resolve({
        content: 'ok',
        reasoning: '',
        tool_calls: [],
        refused: false,
        finish_reason: 'stop',
        raw: {},
      } as NormalizedResult);
    },
  };
  return { provider, captured };
}

describe('ADR A-010 — OpenAI-compatible cache identifiers (prompt_cache_key)', () => {
  it('normalizes the OpenCode alias promptCacheKey to prompt_cache_key (aliases not forwarded raw)', async () => {
    const store = new SessionStore();
    const { provider, captured } = captureProvider();
    const app = await createApp({ provider, sessionStore: store });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'x-session-id': 'ses-1' },
      payload: { ...BODY, promptCacheKey: 'client-key', set_cache_key: true },
    });

    expect(res.statusCode).toBe(200);
    expect(captured.length).toBe(1);
    const p = captured[0].passthrough ?? {};
    expect(p.prompt_cache_key).toBe('client-key');
    expect(p.promptCacheKey).toBeUndefined();
    expect(p.set_cache_key).toBeUndefined();
  });

  it('an explicit OpenAI prompt_cache_key wins over the aliases and the synthesized key', async () => {
    const store = new SessionStore();
    const { provider, captured } = captureProvider();
    const app = await createApp({ provider, sessionStore: store });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'x-session-id': 'ses-2' },
      payload: { ...BODY, prompt_cache_key: 'explicit', promptCacheKey: 'alias-loser' },
    });

    expect(res.statusCode).toBe(200);
    const p = captured[0].passthrough ?? {};
    expect(p.prompt_cache_key).toBe('explicit');
  });

  it('synthesizes evolve_<session-id> when the client sends no identifier', async () => {
    const store = new SessionStore();
    const { provider, captured } = captureProvider();
    const app = await createApp({ provider, sessionStore: store });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'x-session-id': 'ses_abc123' },
      payload: BODY,
    });

    expect(res.statusCode).toBe(200);
    const p = captured[0].passthrough ?? {};
    expect(p.prompt_cache_key).toBe('evolve_ses_abc123');
  });

  it('invents nothing: no session id and no client value -> no prompt_cache_key (A-007)', async () => {
    const store = new SessionStore();
    const { provider, captured } = captureProvider();
    const app = await createApp({ provider, sessionStore: store });

    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: BODY });

    expect(res.statusCode).toBe(200);
    const p = captured[0].passthrough ?? {};
    expect(p.prompt_cache_key).toBeUndefined();
  });

  it('keeps the OpenAI prompt_cache_retention field flowing untouched', async () => {
    const store = new SessionStore();
    const { provider, captured } = captureProvider();
    const app = await createApp({ provider, sessionStore: store });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'x-session-id': 'ses-3' },
      payload: { ...BODY, prompt_cache_retention: '2h' },
    });

    expect(res.statusCode).toBe(200);
    const p = captured[0].passthrough ?? {};
    expect(p.prompt_cache_retention).toBe('2h');
  });
});
