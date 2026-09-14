// ADR A-009 — requests WITHOUT client tools are pure passthroughs.
//
// Auxiliary client calls (e.g. OpenCode's session-title generator, which reuses the parent
// session id) used to run the full inline agent loop: 4+ upstream calls per title, and a
// completing loop DELETED the shared session — wiping the parent's loopState and forcing the
// whole delegated flow to restart (one 31K-token full re-prefill per wipe on llama.cpp).
// Contract under test:
//   1. exactly ONE upstream call, with the client's messages untouched;
//   2. the reply goes back as-is (JSON or SSE, [DONE]-terminated);
//   3. the session store is never created, saved or deleted — a parent's loopState survives.

import { describe, it, expect } from 'vitest';
import { createApp } from '../routes.js';
import { stub, streamingStub } from './stub-provider.js';
import { SessionStore } from '../core/session-store.js';
import { newLoopState, type LoopStateData } from '../core/loop-state.js';

const TITLE_MESSAGES = [
  { role: 'system' as const, content: 'You are a title generator. You output ONLY a thread title. Nothing else.' },
  { role: 'user' as const, content: 'Generate a brief title for this conversation: "Hola"' },
];

describe('ADR A-009 — no-tools requests are pure passthroughs', () => {
  it('non-stream: one upstream call, messages untouched, meta.passthrough, no session created', async () => {
    const store = new SessionStore();
    const provider = stub({ output: 'Hola' });
    const app = await createApp({ provider, sessionStore: store });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'x-session-id': 'sess-title' },
      payload: { model: 'gpt-test', messages: TITLE_MESSAGES },
    });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.choices[0].message.content).toBe('Hola');
    expect(json.meta.passthrough).toBe('no_tools');

    // ONE upstream call (not a 4-phase loop) and the client messages verbatim.
    expect(provider.calls.length).toBe(1);
    expect(provider.calls[0].messages).toEqual(TITLE_MESSAGES);

    // No session bookkeeping of any kind.
    expect(store.get('sess-title')).toBeUndefined();
  });

  it('stream: SSE content + [DONE], one upstream call', async () => {
    const provider = streamingStub({ output: 'Hola' });
    const app = await createApp({ provider });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'x-session-id': 'sess-title-stream' },
      payload: { model: 'gpt-test', messages: TITLE_MESSAGES, stream: true },
    });

    expect(res.statusCode).toBe(200);
    const chunks = res.body
      .split('\n\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.replace(/^data:\s*/, '').trim())
      .filter((p) => p !== '[DONE]')
      .map((p) => JSON.parse(p));

    const content = chunks.map((c) => c.choices?.[0]?.delta?.content ?? '').join('');
    expect(content).toBe('Hola');
    expect(chunks.map((c) => c.choices?.[0]?.finish_reason).find((f) => f && f !== null)).toBe('stop');

    expect(provider.calls.length).toBe(1);
    expect(provider.calls[0].messages).toEqual(TITLE_MESSAGES);
  });

  it('does NOT delete a parent session with a live loopState (the title-wipe regression)', async () => {
    const store = new SessionStore();
    const loopState = newLoopState({
      originalInstruction: 'do the thing',
      internalMessages: [{ role: 'user', content: 'do the thing' }],
      max_rounds: 10,
      spec: null,
      context_window_size: 0,
    });
    store.save({
      sessionId: 'sess-parent',
      model: 'gpt-test',
      pendingToolCalls: [],
      loopState,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const provider = stub({ output: 'title' });
    const app = await createApp({ provider, sessionStore: store });

    // The auxiliary call shares the PARENT's session id (exactly what OpenCode does).
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'x-session-id': 'sess-parent' },
      payload: { model: 'gpt-test', messages: TITLE_MESSAGES },
    });

    expect(res.statusCode).toBe(200);
    expect(provider.calls.length).toBe(1);

    // The parent's loopState survived untouched — the flow can resume without restarting.
    const session = store.get('sess-parent');
    expect(session).toBeDefined();
    expect(session?.loopState).toBe(loopState);
  });
});
