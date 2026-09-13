// Context-window guard (SC-021 / SC-022), re-implemented on top of the A-008 canonical shape:
// the proxy stays proactively below the upstream window BEFORE the call, so
// `ContextWindowExceeded` is prevented, never hit. `windowSize <= 0` = unlimited (no-op).
//
// Plus: the delegated-flow resume contract — the consumed phase result already lives in the
// parent's pile (as the spawn tool's result), so resume() refreshes the base from the incoming
// conversation and clears `lastMessage` (no second copy of the output is ever carried).

import { describe, expect, it } from 'vitest';
import { createLogger } from '../logger.js';
import { estimatePromptTokens, fitToContextWindow } from '../core/phase-prompts.js';
import { SubagentOrchestrator } from '../core/orchestrator.js';
import { newLoopState } from '../core/loop-state.js';
import { stub } from './stub-provider.js';
import type { UpstreamMessage } from '../types.js';

const msg = (role: 'system' | 'user' | 'assistant', content: string): UpstreamMessage =>
  ({ role, content, reasoning: '', tool_calls: [] }) as UpstreamMessage;

describe('fitToContextWindow (SC-021 / SC-022)', () => {
  it('is a no-op for windowSize <= 0 (unlimited: the upstream decides)', () => {
    const prompt = [msg('user', 'x'.repeat(10_000)), msg('assistant', 'y'.repeat(10_000)), msg('user', 'instruction')];
    expect(fitToContextWindow(prompt, 0)).toBe(prompt); // unchanged reference
    expect(fitToContextWindow(prompt, -5)).toBe(prompt);
  });

  it('is a no-op when the prompt already fits under the 75% budget', () => {
    const prompt = [msg('user', 'x'.repeat(400)), msg('assistant', 'y'.repeat(400)), msg('user', 'instruction')];
    const out = fitToContextWindow(prompt, 1000); // ~200 tokens estimated << 750 budget
    expect(out).toBe(prompt);
  });

  it('caps the intermediate assistant turn first (the A-008 second-to-last message)', () => {
    const prompt = [msg('system', 'sys'), msg('user', 'do the thing'), msg('assistant', 'z'.repeat(20_000)), msg('user', 'instruction')];
    const out = fitToContextWindow(prompt, 1000); // budget = 750 tokens = 3000 chars
    const intermediate = out[out.length - 2];
    expect(intermediate.role).toBe('assistant');
    expect((intermediate.content as string).length).toBeLessThanOrEqual(3200);
    expect(intermediate.content).toContain('truncated to fit the context window');
    // Base + instruction travel intact.
    expect(out[0]).toMatchObject({ role: 'system', content: 'sys' });
    expect(out[out.length - 1]).toMatchObject({ role: 'user', content: 'instruction' });
    expect(estimatePromptTokens(out)).toBeLessThanOrEqual(1000);
  });

  it('condenses the oldest middle messages when the intermediate cap is not enough (keeps head, tail-3 and instruction intact)', () => {
    const big = 'w'.repeat(3000);
    const prompt: UpstreamMessage[] = [
      msg('system', 'sys'),
      msg('user', big), // old middle → condensed
      msg('assistant', big), // old middle → condensed
      msg('user', 'recent question'),
      msg('assistant', 'recent answer'),
      msg('user', 'instruction'),
    ];
    const out = fitToContextWindow(prompt, 1000);
    // First message and the newest exchange stay intact…
    expect(out[0].content).toBe('sys');
    expect(out[3]).toMatchObject({ content: 'recent question' });
    expect(out[4]).toMatchObject({ content: 'recent answer' });
    expect(out[out.length - 1]).toMatchObject({ content: 'instruction' });
    // …while the old middle is condensed (structure/roles preserved).
    expect((out[1].content as string).length).toBeLessThan(300);
    expect(out[1].role).toBe('user');
    expect((out[1].content as string)).toContain('condensed to fit the context window');
    expect(out[2].role).toBe('assistant');
  });
});

describe('orchestrator resume — delegated-flow lastMessage contract (ADR A-008, no duplicate copy)', () => {
  function makeState() {
    const state = newLoopState({
      originalInstruction: 'Do the thing',
      internalMessages: [msg('user', 'Do the thing')],
      max_rounds: 3,
      tools: [{ type: 'function', function: { name: 'task', description: '' } }],
      spec: null,
      context_window_size: 0,
    });
    state.spec = {
      toolName: 'task',
      argMapping: { title: 'title', type: 'type', prompt: 'prompt' },
      availableTypes: [{ id: 'default', description: '' }],
      typeId: 'default',
    };
    state.activeTypeId = 'default';
    return state;
  }

  it('after consuming a phase result, the base is refreshed from the parent pile and lastMessage is cleared', () => {
    const orch = new SubagentOrchestrator(stub(), createLogger('test'));
    const state = makeState();
    state.stage = 'planify';
    state.lastMessage = 'interpret raw (must not ride twice)';
    state.pendingAgentId = 'ag-p1';
    state.phaseResults['ag-p1'] = 'PLANIFY OUTPUT';

    // The parent's pile now contains the spawn tool_call + its result (the client persisted it).
    const parentPile: UpstreamMessage[] = [
      msg('user', 'Do the thing'),
      { role: 'assistant', content: '', reasoning: '', tool_calls: [{ id: 'spawn_ag-p1', type: 'function', function: { name: 'task', arguments: '{}' } }] },
      { role: 'tool', content: 'PLANIFY OUTPUT', tool_call_id: 'spawn_ag-p1', reasoning: '', tool_calls: [] },
    ];

    const out = orch.resume(state, 'ses_parent', parentPile);
    expect(out.kind).toBe('tool_call'); // next spawn (execute)

    // Base = the parent pile (which already carries PLANIFY OUTPUT as the tool result)…
    expect(state.internalMessages).toEqual(parentPile);
    expect(state.internalMessages.map((m) => m.content).join('\n')).toContain('PLANIFY OUTPUT');
    // …and the intermediate copy is gone: no assistant turn is appended on top of it.
    expect(state.lastMessage).toBe('');
  });

  it('no incoming pile → keeps the previous base (defensive, e.g. TTL bookkeeping without a request)', () => {
    const orch = new SubagentOrchestrator(stub(), createLogger('test'));
    const state = makeState();
    state.stage = 'planify';
    state.lastMessage = 'interpret raw';
    state.pendingAgentId = 'ag-p2';
    state.phaseResults['ag-p2'] = 'PLANIFY OUTPUT 2';
    const before = state.internalMessages;
    orch.resume(state, 'ses_parent');
    expect(state.internalMessages).toBe(before);
    expect(state.lastMessage).toBe('');
  });
});
