// Unit tests for `complete` / `completeStream` — the provider's SDK-driven path (no network, no HTTP server).
//
// The AI SDK owns transport: it talks to the upstream via fetch and parses SSE into v4 stream parts.
// To test *my* forwarding/normalization logic without reimplementing an event-source parser in tests,
// each provider is constructed with an injected `createClient` seam that yields a fake chat model.
// The fake returns real v4-shaped results (a text part array for generate; an async iterable of
// v4 stream parts for streaming), so these exercises the true types through and around my code.

import { describe, it, expect } from 'vitest';
import type { ProviderClient, V4ChatModel } from '../infrastructure/provider/openai-compatible-provider.js';
import { OpenAICompatibleProvider } from '../infrastructure/provider/openai-compatible-provider.js';
import type { UpstreamMessage } from '../domain/types.js';
import { detectDoomLoop } from '../domain/safety/doom-loop-detector.js';

const MODEL = 'llama_cpp/default';
const MESSAGES: UpstreamMessage[] = [{ role: 'user', content: 'do a thing' }];

/** Build a fake chat model whose stream emits `parts` (text-delta / reasoning-delta) and generate yields one text turn. */
function fakeClient(parts: Array<{ type: string; delta?: string }> = [], generateText = 'hello world'): ProviderClient {
  const model: V4ChatModel = {
    doGenerate: async () => ({
      content: [{ type: 'text', text: generateText }],
      finishReason: { unified: 'stop' as const, raw: undefined },
      usage: { inputTokens: { total: 3, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 0, reasoning: 0 }, raw: undefined },
    }),
    doStream: async () => ({ stream: (async function* () { for (const p of parts) yield p; })() }),
  } as unknown as V4ChatModel;

  return { chatModel: () => model };
}

const reasoningPart = (delta: string): { type: string; delta?: string } => ({ type: 'reasoning-delta', delta });
const textPart = (delta: string): { type: string; delta?: string } => ({ type: 'text-delta', delta });

describe('OpenAICompatibleProvider.completeStream (SC-009/012)', () => {
  it('streams text deltas incrementally, in order, and concatenates to the full content', async () => {
    const chunks: Array<{ reasoning?: string | null; content?: string | null }> = [];
    const parts = [textPart('hel'), textPart('lo '), textPart('world')];

    const provider = new OpenAICompatibleProvider('http://upstream.test', 'sk-test', () => fakeClient(parts));
    await provider.completeStream(MODEL, MESSAGES, { onChunk: (c) => chunks.push(c) });

    expect(chunks.map((c) => c.content ?? '').join('')).toBe('hello world'); // full content via deltas
    expect(chunks.some((c) => c.reasoning !== null)).toBe(false);
  });

  it('delivers reasoning deltas into the reasoning field and text deltas into the content field', async () => {
    const emitted: Array<{ reasoning?: string | null; content?: string | null }> = [];
    const parts = [reasoningPart('alpha'), textPart('x'), reasoningPart('beta')];

    const provider = new OpenAICompatibleProvider('http://upstream.test', 'sk-test', () => fakeClient(parts));
    await provider.completeStream(MODEL, MESSAGES, { onChunk: (c) => emitted.push(c) });

    expect(emitted).toEqual([
      { reasoning: 'alpha', content: null },
      { reasoning: null, content: 'x' },
      { reasoning: 'beta', content: null },
    ]);
  });

  it('accumulates deltas into a runaway pattern detectable mid-stream via the same path the loop uses (SC-012)', async () => {
    // Each arriving reasoning delta accumulates `zzz` — exactly what agent-loop.ts feeds per chunk and how
    // the live gateway can wedge mid-generation (SC-012).
    const parts = Array.from({ length: 7 }, () => reasoningPart('zzz '));
    let acc = '';

    const provider = new OpenAICompatibleProvider('http://upstream.test', 'sk-test', () => fakeClient(parts));
    await provider.completeStream(MODEL, MESSAGES, { onChunk: (c) => { acc += c.reasoning ?? ''; } });

    // After streaming, the accumulated reasoning trips detectDoomLoop — proving the streaming path surfaces
    // a runaway pattern in real time rather than only post-hoc.
    const result = detectDoomLoop(acc, 4);
    expect(result.detected).toBe(true);
    expect(result.repetitions).toBeGreaterThanOrEqual(4);
  });

  it('refuses model=null (no auto) before any upstream request ships (SC-025)', async () => {
    let clientSeen = false;
    const provider = new OpenAICompatibleProvider('http://upstream.test', 'sk-test', () => {
      clientSeen = true;
      return fakeClient();
    });

    await expect(provider.completeStream(null, MESSAGES, { onChunk: () => {} })).rejects.toThrow(/concrete model/);
    expect(clientSeen).toBe(false);
  });

  it('refuses model="auto" (no auto) before any upstream request ships (SC-025)', async () => {
    let clientSeen = false;
    const provider = new OpenAICompatibleProvider('http://upstream.test', 'sk-test', () => {
      clientSeen = true;
      return fakeClient();
    });

    await expect(provider.completeStream('auto', MESSAGES, { onChunk: () => {} })).rejects.toThrow(/concrete model/);
    expect(clientSeen).toBe(false);
  });
});

describe('OpenAICompatibleProvider.complete (SC-025)', () => {
  it('refuses model=null before dispatching to the SDK', async () => {
    let clientSeen = false;
    const provider = new OpenAICompatibleProvider('http://upstream.test', 'sk-test', () => {
      clientSeen = true;
      return fakeClient();
    });

    await expect(provider.complete(null, MESSAGES)).rejects.toThrow(/concrete model/);
    expect(clientSeen).toBe(false);
  });

  it('refuses model="auto" before dispatching to the SDK (SC-025)', async () => {
    let clientSeen = false;
    const provider = new OpenAICompatibleProvider('http://upstream.test', 'sk-test', () => {
      clientSeen = true;
      return fakeClient();
    });

    await expect(provider.complete('auto', MESSAGES)).rejects.toThrow(/concrete model/);
    expect(clientSeen).toBe(false);
  });

  it('normalizes an SDK generate result into the loop shape', async () => {
    const provider = new OpenAICompatibleProvider('http://upstream.test', 'sk-test', () => fakeClient([], 'hello world'));
    const res = await provider.complete(MODEL, MESSAGES);

    expect(res.content).toBe('hello world');
    expect(res.reasoning).toBe('');
    expect(res.finish_reason).toBe('stop');
    expect(res.usage?.total_tokens).toBe(8); // 3 prompt + 5 completion tokens
    expect(res.refused).toBe(false);
  });

  it('forwards passthrough max_tokens / temperature into the v4 call options (ADR A-007)', async () => {
    let capturedOptions: Record<string, unknown> = {};
    const captureClient: ProviderClient = {
      chatModel: () => ({
        doGenerate: async (opts: any) => {
          capturedOptions = opts;
          return {
            content: [{ type: 'text', text: 'ok' }],
            finishReason: { unified: 'stop' as const, raw: undefined },
            usage: { inputTokens: { total: 1, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 0, reasoning: 0 }, raw: undefined },
          } as unknown as V4ChatModel;
        },
        doStream: async () => ({ stream: (async function* () {})() }),
      }) as unknown as V4ChatModel,
    };
    const provider = new OpenAICompatibleProvider('http://upstream.test', 'sk-test', () => captureClient);

    await provider.complete(MODEL, MESSAGES, { passthrough: { temperature: 0.7, max_tokens: 256 } });

    // The SDK maps these v4 keys into the upstream request body (max_tokens / temperature).
    expect(capturedOptions.maxOutputTokens).toBe(256);
    expect(capturedOptions.temperature).toBe(0.7);
  });

  it('forwards EVERY other passthrough field raw via providerOptions (ADR A-007 verbatim)', async () => {
    let capturedOptions: Record<string, unknown> = {};
    const captureClient: ProviderClient = {
      chatModel: () => ({
        doGenerate: async (opts: any) => {
          capturedOptions = opts;
          return {
            content: [{ type: 'text', text: 'ok' }],
            finishReason: { unified: 'stop' as const, raw: undefined },
            usage: { inputTokens: { total: 1, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 0, reasoning: 0 }, raw: undefined },
          } as unknown as V4ChatModel;
        },
        doStream: async () => ({ stream: (async function* () {})() }),
      }) as unknown as V4ChatModel,
    };
    const provider = new OpenAICompatibleProvider('http://upstream.test', 'sk-test', () => captureClient);

    await provider.complete(MODEL, MESSAGES, {
      passthrough: {
        top_p: 0.9,
        top_k: 5,
        seed: 42,
        stop: ['end'],
        logprobs: true,
        stream_options: { include_usage: true },
        user: 'client-1',
        metadata: { origin: 'opencode' },
        parallel_tool_calls: false,
        reasoning_effort: 'high',
        max_completion_tokens: 4096,
      },
    });

    // Recognized fields map to v4 options (the SDK knows their OpenAI body names)...
    expect(capturedOptions.topP).toBe(0.9);
    expect(capturedOptions.seed).toBe(42);
    expect(capturedOptions.stopSequences).toEqual(['end']);
    // ...the client's reasoning_effort rides the v4 `reasoning` (custom-reasoning string) path —
    // the SDK writes it verbatim into the body's `reasoning_effort` field.
    expect(capturedOptions.reasoning).toBe('high');
    // ...everything else rides raw, untouched, under the stable provider namespace — the SDK
    // spreads these verbatim into the upstream request body.
    const raw = (capturedOptions.providerOptions as Record<string, Record<string, unknown>>).evolve_upstream;
    expect(raw).toEqual({
      top_k: 5,
      logprobs: true,
      stream_options: { include_usage: true },
      user: 'client-1',
      metadata: { origin: 'opencode' },
      parallel_tool_calls: false,
      max_completion_tokens: 4096,
    });
  });

  it('never forwards reserved client fields (messages/model/stream/tools/tool_choice/evolve controls)', async () => {
    let capturedOptions: Record<string, unknown> = {};
    const captureClient: ProviderClient = {
      chatModel: () => ({
        doGenerate: async (opts: any) => {
          capturedOptions = opts;
          return {
            content: [{ type: 'text', text: 'ok' }],
            finishReason: { unified: 'stop' as const, raw: undefined },
            usage: { inputTokens: { total: 1, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 0, reasoning: 0 }, raw: undefined },
          } as unknown as V4ChatModel;
        },
        doStream: async () => ({ stream: (async function* () {})() }),
      }) as unknown as V4ChatModel,
    };
    const provider = new OpenAICompatibleProvider('http://upstream.test', 'sk-test', () => captureClient);

    await provider.complete(MODEL, MESSAGES, {
      passthrough: {
        model: 'alias/name',
        messages: [{ role: 'user', content: 'x' }],
        stream: true,
        tools: [{ type: 'function', function: { name: 't', parameters: {} } }],
        tool_choice: 'auto',
        max_rounds: 3,
        doom_loop_threshold: 2,
      },
      tools: [{ type: 'function', function: { name: 'real', parameters: {} } }],
    });

    // Reserved keys are transformed (model/messages), SDK-managed (stream), or proxy controls —
    // they must NOT appear raw in the forwarded options...
    const raw = (capturedOptions.providerOptions as Record<string, Record<string, unknown>> | undefined)?.evolve_upstream;
    expect(raw).toBeUndefined();
    // ...and the client's real tools ride the converted path (not the reserved one).
    expect((capturedOptions.tools as any[]).map((t) => t.name)).toEqual(['real']);
  });

  it('leaves call options empty when there is no passthrough (no invented values)', async () => {
    let capturedOptions: Record<string, unknown> = {};
    const captureClient: ProviderClient = {
      chatModel: () => ({
        doGenerate: async (opts: any) => {
          capturedOptions = opts;
          return {
            content: [{ type: 'text', text: 'ok' }],
            finishReason: { unified: 'stop' as const, raw: undefined },
            usage: { inputTokens: { total: 1, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 0, reasoning: 0 }, raw: undefined },
          } as unknown as V4ChatModel;
        },
        doStream: async () => ({ stream: (async function* () {})() }),
      }) as unknown as V4ChatModel,
    };
    const provider = new OpenAICompatibleProvider('http://upstream.test', 'sk-test', () => captureClient);

    await provider.complete(MODEL, MESSAGES, {});

    // The proxy never invents values: no client field -> no forwarded option.
    expect(capturedOptions.maxOutputTokens).toBeUndefined();
    expect(capturedOptions.temperature).toBeUndefined();
    expect(capturedOptions.providerOptions).toBeUndefined();
  });

  it('maps a content-filter finish reason to refused=true', async () => {
    const provider = new OpenAICompatibleProvider('http://upstream.test', 'sk-test', () => ({
      chatModel: () =>
        ({
          doGenerate: async () => ({
            content: [{ type: 'text', text: 'redacted' }],
            finishReason: { unified: 'content-filter' as const, raw: undefined },
            usage: { inputTokens: { total: 1, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 0, reasoning: 0 }, raw: undefined },
          }),
          doStream: async () => ({ stream: (async function* () {})() }),
        } as unknown as V4ChatModel),
    }));

    await expect(provider.complete(MODEL, MESSAGES)).resolves.toMatchObject({ refused: true, finish_reason: 'content-filter' });
  });
});
