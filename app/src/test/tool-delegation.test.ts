// Route + store tests for bidirectional tool delegation (FASE 2).
//
// The wire contract under test: when the upstream model requests client-side tool calls, the
// proxy MUST emit standard OpenAI streaming chunks — `delta.tool_calls` with id/name/arguments,
// then `finish_reason: "tool_calls"`, then `[DONE]` — so an OpenAI-compatible client (opencode /
// Vercel AI SDK) finalizes the tool calls and executes them locally. No proprietary events.

import { describe, it, expect } from 'vitest';
import { createApp } from '../routes.js';
import { streamingStub, stub } from './stub-provider.js';
import { SessionStore } from '../core/session-store.js';
import type { ChatProvider } from '../provider/types.js';
import type { ToolCall } from '../types.js';

const TOOLS = [
  { type: 'function' as const, function: { name: 'search', description: 'search the web', parameters: { type: 'object', properties: { q: { type: 'string' } } } } },
];

const CALLS: ToolCall[] = [
  { id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"q":"evolve proxy"}' } },
];

const BASE_PAYLOAD = {
  model: 'gpt-test',
  messages: [{ role: 'user', content: 'find the answer' }],
  tools: TOOLS,
  tool_choice: 'auto' as const,
};

/** Parse an SSE response body into its JSON chunk payloads. */
function parseSseChunks(body: string): Array<Record<string, any>> {
  return body
    .split('\n\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => {
      const payload = line.replace(/^data:\s*/, '').trim();
      if (payload === '[DONE]') return { __done: true };
      return JSON.parse(payload);
    });
}

describe('FASE 2 — streaming tool delegation wire contract', () => {
  it('emits delta.tool_calls chunks + finish_reason tool_calls + [DONE] (standard OpenAI stream)', async () => {
    const store = new SessionStore();
    const provider = streamingStub({ evalComplete: true, toolCalls: CALLS });
    const app = await createApp({ provider, sessionStore: store });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'x-session-id': 'sess-f2' },
      payload: { ...BASE_PAYLOAD, stream: true },
    });

    expect(res.statusCode).toBe(200);
    const chunks = parseSseChunks(res.body);

    // At least one chunk carries the complete tool call with id/name/arguments.
    const toolChunks = chunks
      .map((c) => c.choices?.[0]?.delta?.tool_calls?.[0])
      .filter(Boolean);
    expect(toolChunks.length).toBeGreaterThanOrEqual(1);
    expect(toolChunks[0]).toMatchObject({
      id: 'call_1',
      type: 'function',
      function: { name: 'search', arguments: '{"q":"evolve proxy"}' },
    });

    // The terminating chunk says tool_calls (the client runs the tools and resumes).
    const finish = chunks.map((c) => c.choices?.[0]?.finish_reason).find((f) => f && f !== null);
    expect(finish).toBe('tool_calls');

    // The stream still ends with [DONE].
    expect(chunks[chunks.length - 1]).toEqual({ __done: true });

    // The pending session was recorded under the x-session-id header.
    const session = store.get('sess-f2');
    expect(session).toBeDefined();
    expect(session?.pendingToolCalls).toEqual(CALLS);
    expect(session?.tools).toEqual(TOOLS);
  });

  it('non-stream path returns finish_reason tool_calls and message.tool_calls', async () => {
    const store = new SessionStore();
    const provider = stub({ evalComplete: true, toolCalls: CALLS });
    const app = await createApp({ provider, sessionStore: store });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'x-session-id': 'sess-f2b' },
      payload: BASE_PAYLOAD,
    });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.choices[0].finish_reason).toBe('tool_calls');
    expect(json.choices[0].message.tool_calls).toEqual(CALLS);
    expect(json.choices[0].message.content).toBeNull();
  });
});

describe('FASE 2 — validation of delegated-tool requests', () => {
  it('accepts a resumed tool exchange (assistant tool_calls + tool result, null content)', async () => {
    const provider = stub({ evalComplete: true, output: 'final answer' });
    const app = await createApp({ provider });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'gpt-test',
        messages: [
          { role: 'user', content: 'find the answer' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } }],
          },
          { role: 'tool', tool_call_id: 'call_1', content: 'found it' },
        ],
        tools: TOOLS,
      },
    });

    expect(res.statusCode).toBe(200);
  });

  it('rejects a malformed tool_choice (SC-016/SC-024 contract preserved)', async () => {
    const provider = stub({ evalComplete: true });
    const app = await createApp({ provider });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { ...BASE_PAYLOAD, tool_choice: 'sometimes' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('tool_choice');
  });

  it('rejects a malformed tools array', async () => {
    const provider = stub({ evalComplete: true });
    const app = await createApp({ provider });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { ...BASE_PAYLOAD, tools: [{ type: 'not-a-function', function: { name: 'x' } }] },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('FASE 2 — SessionStore TTL', () => {
  it('evicts sessions after the TTL expires', async () => {
    const store = new SessionStore(1); // 1 ms TTL
    store.save({
      sessionId: 't1',
      model: 'gpt-test',
      pendingToolCalls: CALLS,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(store.get('t1')).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it('keeps a live session and drops it on terminal bookkeeping', async () => {
    const store = new SessionStore();
    store.save({ sessionId: 't2', model: 'm', pendingToolCalls: CALLS, createdAt: Date.now(), updatedAt: Date.now() });
    expect(store.get('t2')?.pendingToolCalls).toEqual(CALLS);
    store.delete('t2');
    expect(store.get('t2')).toBeUndefined();
  });
});
