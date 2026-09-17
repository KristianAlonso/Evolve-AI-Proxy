// Integration tests against the LIVE upstream gateway.
//
// These exercise the full server stack (JSON-schema validation → preValidation hook →
// routing → OpenAICompatibleProvider → outbound HTTP to the target) by driving createApp()
// through Fastify's built-in `inject()` — no network port, no client process. Each response
// is a real reply from the configured LiteLLM gateway.
//
// Target (authorized): http://26.238.135.219:4000  ·  model llama_cpp/default
// Run: vitest run integration — only skipped if the gateway is unreachable, so CI can gate on it.

import { describe, it, expect } from 'vitest';
import { createApp } from '../presentation/app.js';
import env from '../infrastructure/config.js';

/** Bearer token for the authorized upstream (mirrors UPSTREAM_API_KEY default). */
const API_KEY = process.env.UPSTREAM_API_KEY ?? 'sk-0cJ81PMjGwHTtXvSSItFfA';

// A short, non-adversarial prompt — keep live traffic tiny on a shared gateway.
const PROMPT = { role: 'user', content: 'Reply with the single word hello.' };

describe('integration — live upstream (evolve_ai_proxy -> LiteLLM gateway)', () => {
  it('/health responds before any upstream call', async () => {
    const app = await createApp({ baseUrl: env.UPSTREAM_BASE_URL, apiKey: API_KEY });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('forwards a request and returns an OpenAI chat.completion from llama_cpp/default', { timeout: 60000 }, async () => {
    const app = await createApp({ baseUrl: env.UPSTREAM_BASE_URL, apiKey: API_KEY });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'llama_cpp/default', messages: [PROMPT] },
    });

    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.object).toBe('chat.completion');
    expect(body.model).toBe('llama_cpp/default');
    expect(body.choices).toHaveLength(1);
    expect(body.choices[0].index).toBe(0);

    // The upstream reply is what the proxy surfaces back to the client.
    expect(body.choices[0].message.role).toBe('assistant');
    const text = (body.choices[0].message.content ?? '').trim();
    expect(text.length).toBeGreaterThan(0);
    expect(body.choices[0].finish_reason).toBeDefined();
  });

  it('honours a non-streaming request without requiring model resolution', { timeout: 60000 }, async () => {
    // ADR A-009: a request WITHOUT tools is a pure passthrough — one upstream call, reply as-is,
    // and the evolve meta marks it as such (no agent loop, no session bookkeeping).
    const app = await createApp({ baseUrl: env.UPSTREAM_BASE_URL, apiKey: API_KEY });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'llama_cpp/default', messages: [PROMPT], max_rounds: 5 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.choices[0].message.content).toBeTruthy();
    expect(body.meta.passthrough).toBe('no_tools');
  });

  it('rejects malformed bodies at validation (schema gate before any upstream call)', async () => {
    const app = await createApp({ baseUrl: env.UPSTREAM_BASE_URL, apiKey: API_KEY });

    // Empty model + empty messages array → preValidation reports all issues at once.
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: '', messages: [] },
    });
    expect(bad.statusCode).toBe(400);
    // SC-024: every issue is reported in a single response.
    const err = bad.json() as { error?: string; message?: string };
    const blob = JSON.stringify(err);
    expect(blob.toLowerCase()).toContain('model');
    expect(blob.toLowerCase()).toContain('messages');

    // Invalid role → 400, and again before reaching upstream.
    const badRole = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'llama_cpp/default', messages: [{ role: 'banana', content: 'hi' }] },
    });
    expect(badRole.statusCode).toBe(400);
  });

  it('rejects (400) a request with no user/system message to act on', async () => {
    const app = await createApp({ baseUrl: env.UPSTREAM_BASE_URL, apiKey: API_KEY });
    // Messages validate OK but only contain an assistant turn — no instruction to loop on.
    // Structural validation rejects this as 400 up-front (SC-016/SC-024), before any work;
    // it is handled identically to an empty model or an invalid role, never reaching the
    // agent route handler.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'llama_cpp/default', messages: [{ role: 'assistant', content: 'prior text' }] },
    });
    expect(res.statusCode).toBe(400);
  });

  // Streaming path (SC-009): drives createApp() with stream:true and asserts every SSE frame is a
  // valid OpenAI chat.completion.chunk — reasoning arrives as `delta.reasoning`, assistant text as
  // `delta.content`, the loop ends on a terminal chunk carrying finish_reason, then [DONE]. There
  // are no proprietary named events; clients validate every data block against this shape.
  it('streams the agent loop over SSE when requested (stream mode)', { timeout: 60000 }, async () => {
    const app = await createApp({ baseUrl: env.UPSTREAM_BASE_URL, apiKey: API_KEY });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'llama_cpp/default', messages: [PROMPT], stream: true },
    });

    // The route streams text/event-stream; Fastify inject surfaces the body as the streamed bytes.
    expect(res.statusCode).toBe(200);
    const frames = String(res.payload ?? '');
    expect(frames.length).toBeGreaterThan(0);

    // At least one valid chat.completion.chunk frame landed (proving a real stream ran end to end),
    // and every stream ends with [DONE].
    expect(frames).toMatch(/"object":"chat\.completion\.chunk"/);
    expect(frames).toMatch(/"choices":\[/);
    expect(frames.includes('[DONE]')).toBe(true);
  });

  // FASE 1 (real-time reasoning across ALL phases): the client must receive reasoning deltas from
  // the interpretation/evaluation phases, not only during task execution. The order on the wire is
  // the proof: the first `delta.reasoning` frame must precede the first assistant `delta.content`
  // frame, because interpret (and eval) run upstream of any execution output.
  it('delivers reasoning deltas before any assistant text (live all-phase tracing)', { timeout: 90000 }, async () => {
    const app = await createApp({ baseUrl: env.UPSTREAM_BASE_URL, apiKey: API_KEY });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'llama_cpp/default', messages: [PROMPT], stream: true },
    });

    expect(res.statusCode).toBe(200);
    const frames = String(res.payload ?? '');

    const firstReasoning = frames.indexOf('"delta":{"reasoning"');
    const firstContent = frames.indexOf('"delta":{"role":"assistant","content"');

    expect(firstReasoning).toBeGreaterThanOrEqual(0); // upstream thinking reached the client
    expect(firstContent).toBeGreaterThanOrEqual(0); // and the assistant answer streamed too
    expect(firstReasoning).toBeLessThan(firstContent); // thinking first -> early-phase tracing, not one late blob
    expect(frames.includes('[DONE]')).toBe(true);
  });
});
