// FASE 6 / A-009 — subagent CONTINUATIONS are pure passthroughs.
//
// A subagent whose first request already ran the delegated phase (envelope present + there are
// assistant/tool turns after it) is iterating on ITS OWN task. The old behavior ("serving as a
// normal request") fell through to the inline agent loop: interpret/planify/execute/evaluate ran
// ON TOP OF the subagent's own conversation, so the execute subagent got a nested evaluate/planify
// loop instead of focusing on its task, and every continuation tripled the upstream calls
// (verified live: the execute subagent emitted planify JSON {"mainObjective":...} and evaluate
// JSON {"complete":true} inside its own tool loop).
// Contract under test:
//   1. exactly ONE upstream call with the subagent's pile VERBATIM (no phase-prompt injection);
//   2. tools/tool_choice forwarded (the subagent's own LLM keeps running its tools);
//   3. the reply goes back as-is and, when it's a plain-content reply, the parent's phase result
//      is refreshed (last content wins); when the reply is a tool_calls request, NOTHING is
//      recorded (the subagent is still working) and the tool_calls are relayed to the client.

import { describe, it, expect } from 'vitest';
import { createApp } from '../presentation/app.js';
import { stub, resp } from './stub-provider.js';
import { SessionStore } from '../domain/session-store.js';
import { newLoopState } from '../domain/loop-state.js';
import { buildSpawnPrompt } from '../domain/subagent-spawn.js';
import type { ToolCall, ToolDefinition, UpstreamMessage } from '../domain/types.js';
import type { ChatProvider } from '../domain/provider/types.js';
import type { NormalizedResult } from '../domain/types.js';

const BASH_TOOL: ToolDefinition = {
  type: 'function',
  function: { name: 'bash', description: 'Run a shell command.', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
};

/** Provider that records options (tools) too, and always replies with a fixed result. */
function fixedProvider(result: NormalizedResult): ChatProvider & { calls: Array<{ model: string | null; messages: UpstreamMessage[]; options?: { tools?: ToolDefinition[] } }> } {
  const calls: Array<{ model: string | null; messages: UpstreamMessage[]; options?: { tools?: ToolDefinition[] } }> = [];
  const record = (model: string | null, messages: UpstreamMessage[], options?: Parameters<ChatProvider['complete']>[2]) => {
    calls.push({ model, messages, options: { tools: options?.tools } });
    return Promise.resolve(result);
  };
  return {
    async listModels() {
      return [];
    },
    complete: (model, messages, options) => record(model, messages, options),
    calls,
  };
}

/** Streaming variant of fixedProvider (completeStream only) for the SSE path. */
function streamingFixedProvider(result: NormalizedResult): ChatProvider & { calls: number } {
  let count = 0;
  return {
    async listModels() {
      return [];
    },
    async complete() {
      count++;
      return result;
    },
    async completeStream(_model: string | null, _messages: UpstreamMessage[], opts?: { options?: unknown; onChunk?: (c: { reasoning?: string; content?: string; tool_call?: ToolCall }) => void }) {
      count++;
      const onChunk = opts?.onChunk;
      const reasoning = result.reasoning ?? '';
      const content = result.content ?? '';
      if (reasoning !== '') onChunk?.({ reasoning });
      if (content !== '') onChunk?.({ content });
      for (const call of result.tool_calls ?? []) onChunk?.({ tool_call: call });
    },
    get calls() {
      return count;
    },
  } as unknown as ChatProvider & { calls: number };
}

function parentWithExecutePhase(store: SessionStore) {
  const loopState = newLoopState({
    originalInstruction: 'Instala la skill grill-me',
    internalMessages: [{ role: 'user', content: 'Instala la skill grill-me' }],
    max_rounds: 10,
    spec: null,
    context_window_size: 0,
  });
  loopState.stage = 'execute';
  loopState.pendingAgentId = 'agent-x';
  store.save({
    sessionId: 'sess-parent',
    model: 'gpt-test',
    pendingToolCalls: [],
    loopState,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

const spawnPrompt = buildSpawnPrompt(
  { phase: 'execute', parent_session_id: 'sess-parent', agent_id: 'agent-x' },
  'Execute the task: install the skill grill-me.\nACCEPTANCE: DONE when the skill is installed.',
);

/** The subagent's own pile after its first tool round: spawn prompt, an assistant tool_calls turn, a tool result. */
const continuationMessages = [
  { role: 'user' as const, content: spawnPrompt, reasoning: '', tool_calls: [] },
  {
    role: 'assistant' as const,
    content: null,
    reasoning: '',
    tool_calls: [{ id: 'call_1', type: 'function' as const, function: { name: 'bash', arguments: '{"command":"npx skills add grill-me"}' } }],
  },
  { role: 'tool' as const, content: 'added 1 package in 3s', tool_call_id: 'call_1', tool_name: 'bash' },
];

describe('FASE 6 / A-009 — subagent continuations are pure passthroughs', () => {
  it('one upstream call with the pile verbatim, tools forwarded, phase result refreshed', async () => {
    const store = new SessionStore();
    parentWithExecutePhase(store);
    const provider = fixedProvider(resp({ content: 'Skill grill-me installed successfully.' }));
    const app = await createApp({ provider, sessionStore: store });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'x-session-id': 'sess-sub' },
      payload: { model: 'gpt-test', messages: continuationMessages, tools: [BASH_TOOL] },
    });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.choices[0].message.content).toBe('Skill grill-me installed successfully.');
    expect(json.meta.passthrough).toBe('subagent_continuation');

    // Exactly ONE upstream call — no interpret/planify/execute/evaluate loop on top of the pile.
    expect(provider.calls.length).toBe(1);
    expect(provider.calls[0].messages).toEqual(continuationMessages);
    // The subagent's tools are forwarded so its own LLM can keep calling them.
    expect(provider.calls[0].options?.tools).toEqual([BASH_TOOL]);

    // The parent's execute phase result was refreshed (last content wins).
    const parent = store.get('sess-parent');
    expect(parent?.loopState?.phaseResults['agent-x']).toBe('Skill grill-me installed successfully.');
  });

  it('a reply that is a tool_calls request relays the calls and records NOTHING (subagent still working)', async () => {
    const store = new SessionStore();
    parentWithExecutePhase(store);
    store.get('sess-parent')!.loopState!.phaseResults['agent-x'] = ''; // untouched sentinel
    const provider = fixedProvider(
      resp({
        content: null,
        tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }],
        finish_reason: 'tool_calls',
      }),
    );
    const app = await createApp({ provider, sessionStore: store });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'x-session-id': 'sess-sub' },
      payload: { model: 'gpt-test', messages: continuationMessages, tools: [BASH_TOOL] },
    });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.choices[0].message.content).toBeNull();
    expect(json.choices[0].message.tool_calls).toHaveLength(1);
    expect(json.choices[0].finish_reason).toBe('tool_calls');

    // One upstream call, pile verbatim.
    expect(provider.calls.length).toBe(1);
    expect(provider.calls[0].messages).toEqual(continuationMessages);

    // Nothing recorded — the subagent is still iterating; its later content will win.
    expect(store.get('sess-parent')?.loopState?.phaseResults['agent-x']).toBe('');
  });

  it('STREAMING: a tool_calls reply is relayed as tool_calls chunks BEFORE the finish chunk (live 15:14 regression)', async () => {
    const store = new SessionStore();
    parentWithExecutePhase(store);
    store.get('sess-parent')!.loopState!.phaseResults['agent-x'] = ''; // untouched sentinel
    const call: ToolCall = { id: 'call_bash', type: 'function', function: { name: 'bash', arguments: '{"command":"npx skills find grill-me"}' } };
    const provider = streamingFixedProvider(
      resp({ content: null, tool_calls: [call], finish_reason: 'tool_calls', reasoning: 'Search for the grill-me skill.' }),
    );
    const app = await createApp({ provider, sessionStore: store });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'x-session-id': 'sess-sub-stream' },
      payload: { model: 'gpt-test', stream: true, messages: continuationMessages, tools: [BASH_TOOL] },
    });

    expect(res.statusCode).toBe(200);
    const body = res.body;

    // The tool call MUST appear in the SSE stream — before the finish chunk. Without it the
    // client (opencode) saw finish_reason: "tool_calls" with no call data and DROPPED the call,
    // ending the subagent loop with an empty result (verified live: msg had only a reasoning
    // part + step-finish reason=stop).
    const toolCallFrame = body.indexOf('"bash"');
    expect(toolCallFrame).toBeGreaterThan(-1);
    expect(body).toContain('call_bash');
    expect(body).toContain('npx skills find grill-me');
    const finishFrame = body.indexOf('"finish_reason":"tool_calls"');
    expect(finishFrame).toBeGreaterThan(-1);
    expect(toolCallFrame).toBeLessThan(finishFrame);
    expect(body.trimEnd().endsWith('data: [DONE]')).toBe(true);

    // One upstream call, pile verbatim.
    expect(provider.calls).toBe(1);
    // Nothing recorded — the subagent is still iterating.
    expect(store.get('sess-parent')?.loopState?.phaseResults['agent-x']).toBe('');
  });

  it('the stub router is NOT used for continuations (no loop phase runs at all)', async () => {
    const store = new SessionStore();
    parentWithExecutePhase(store);
    // If the continuation fell through to the inline loop, the router would answer the
    // interpreter prompt with JSON like {"mainObjective":...}. With the passthrough, the
    // subagent's pile is what goes upstream and the plain output comes back.
    const provider = stub({ output: 'plain continuation reply' });
    const app = await createApp({ provider, sessionStore: store });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'x-session-id': 'sess-sub2' },
      payload: { model: 'gpt-test', messages: continuationMessages, tools: [BASH_TOOL] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().choices[0].message.content).toBe('plain continuation reply');
    expect(provider.calls.length).toBe(1);
    // No phase prompt was injected: the single upstream call IS the client pile.
    expect(provider.calls[0].messages).toEqual(continuationMessages);
  });
});
