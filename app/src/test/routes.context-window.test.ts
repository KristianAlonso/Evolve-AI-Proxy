// Route-level test for context-window resolution (SC-021 / SC-022).
//
// The proxy resolves the maximum context window per this order:
//   1) API that serves the model — GET /v1/models advertised max_input_tokens;
//   2) an explicit body.context_window_size on the request;
//   3) unlimited (`0`) when neither is available.
//
// These run against an injected in-memory stub (no upstream), so they assert the *resolution
// contract* deterministically: consult /v1/models only when the request does not declare a size.

import { describe, it, expect, vi } from 'vitest';
import { createApp } from '../routes.js';
import { stub, type StubRecord } from './stub-provider.js';
import type { ChatProvider } from '../provider/types.js';

const PROMPT = [{ role: 'user' as const, content: 'Take a single step toward the goal.' }];

describe('route — context-window resolution (SC-021 / SC-022)', () => {
  it('consults /v1/models when the request omits context_window_size', async () => {
    const provider = stub({ evalComplete: false }) as unknown as ChatProvider;

    // Replace listModels with a spy so we can prove the route consulted /v1/models.
    const listModelsSpy = vi.spyOn(provider, 'listModels').mockResolvedValue([]);
    const app = await createApp({ provider });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'llama_cpp/default', messages: PROMPT }, // no context_window_size here
    });

    expect(res.statusCode).toBe(200);
    // The consult happened exactly once, ahead of the agent loop doing any work.
    expect(listModelsSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT consult /v1/models when context_window_size is declared on the request', async () => {
    const provider = stub({ evalComplete: false }) as ChatProvider & { listModels: ChatProvider['listModels'] };

    const listModelsSpy = vi.spyOn(provider, 'listModels').mockResolvedValue([]);
    const app = await createApp({ provider });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'llama_cpp/default', messages: PROMPT, context_window_size: 4096 },
    });

    expect(res.statusCode).toBe(200);
    // A declared size still short-circuits *context-window* resolution (we never ask /v1/models for a
    // cap), but alias/auto model resolution needs the listing too — SC-016/SC-024 + AUTO_RESOLVE_MODEL.
    // The single per-request listing is consulted exactly once, shared by both subsystems, never more.
    expect(listModelsSpy).toHaveBeenCalledTimes(1);
  });
});
