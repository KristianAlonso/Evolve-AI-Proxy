// Unit tests for `complete` / `completeStream` — the provider's SDK-driven path (no network, no HTTP server).
//
// The AI SDK owns transport: it talks to the upstream via fetch and parses SSE into v4 stream parts.
// To test *my* forwarding/normalization logic without reimplementing an event-source parser in tests,
// each provider is constructed with an injected `createClient` seam that yields a fake chat model.
// The fake returns real v4-shaped results (a text part array for generate; an async iterable of
// v4 stream parts for streaming), so these exercises the true types through and around my code.

import { describe, it, expect } from 'vitest';
import type { ProviderClient, V4ChatModel } from '../provider/openai-compatible-provider.js';
import { OpenAICompatibleProvider } from '../provider/openai-compatible-provider.js';
import type { UpstreamMessage } from '../types.js';
import { detectDoomLoop } from '../safety/doom-loop-detector.js';

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

  it('forwards caller max_tokens / temperature into the v4 call options (bug fix: previously dropped)', async () => {
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

    await provider.complete(MODEL, MESSAGES, { temperature: 0.7, max_tokens: 256 });

    // The SDK maps these v4 keys into the upstream request body (max_tokens / temperature).
    expect(capturedOptions.maxOutputTokens).toBe(256);
    expect(capturedOptions.temperature).toBe(0.7);
  });

  it('leaves call options undefined when the caller passes neither max_tokens nor temperature', async () => {
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

    expect(capturedOptions.maxOutputTokens).toBeUndefined();
    expect(capturedOptions.temperature).toBeUndefined();
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
