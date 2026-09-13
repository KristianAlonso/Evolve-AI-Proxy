// Client-delegated context compaction (ADR A-008 follow-up): the proxy NEVER truncates, cuts or
// condenses a prompt. After each upstream call the REAL usage is compared against
// `context_window_size x threshold`; at/over the threshold the flow is interrupted
// (decision/flag `context_compact_pending`) and the compaction is delegated to the client:
//   1. the proxy relays the real usage (the client tracks tokens per message from it),
//   2. the client's own compaction request passes through as-is (pure passthrough),
//   3. the client's next (compacted) request resumes the interrupted phase — the old stored
//      messages are discarded and the new pile is adopted (orchestrator resume).
// `windowSize <= 0` (unknown window) disables the check: the upstream decides (SC-022).

import { describe, expect, it } from 'vitest';
import { createLogger } from '../logger.js';
import { COMPACT_PENDING_NOTICE, contextFull, isCompactionRequest } from '../core/phase-prompts.js';
import { SubagentOrchestrator } from '../core/orchestrator.js';
import { AgentLoop } from '../core/agent-loop.js';
import { newLoopState, type LoopStateData } from '../core/loop-state.js';
import { stub } from './stub-provider.js';
import type { ChatProvider, ProviderCallOptions } from '../provider/types.js';
import type { NormalizedResult, TokenUsage, ToolDefinition, UpstreamMessage } from '../types.js';

const log = createLogger('test');

const msg = (role: 'system' | 'user' | 'assistant', content: string): UpstreamMessage =>
  ({ role, content, reasoning: '', tool_calls: [] }) as UpstreamMessage;

const FULL_USAGE: TokenUsage = { prompt_tokens: 9500, completion_tokens: 100, total_tokens: 9600 };
const HALF_USAGE: TokenUsage = { prompt_tokens: 4000, completion_tokens: 100, total_tokens: 4100 };

/** Wrap a stub provider so every routed response carries a fixed (real) usage. */
function withUsage(base: ReturnType<typeof stub>, usage: TokenUsage | undefined) {
  return {
    ...base,
    async complete(model: string | null, messages: UpstreamMessage[], options?: ProviderCallOptions): Promise<NormalizedResult> {
      const r = await base.complete(model, messages, options);
      return { ...r, usage };
    },
  };
}

/** Wrap a stub provider so the tool-mapper prompt gets a canned answer (mapping succeeds). */
function withMapping(base: ReturnType<typeof stub>, answer: string) {
  return {
    ...base,
    async complete(model: string | null, messages: UpstreamMessage[], options?: ProviderCallOptions): Promise<NormalizedResult> {
      const combined = messages.map((m) => m.content ?? '').join('\n');
      if (combined.includes('tool mapper')) {
        base.calls.push({ model, messages });
        return { content: answer, reasoning: '', tool_calls: [], refused: false, finish_reason: 'stop', raw: {} };
      }
      return base.complete(model, messages, options);
    },
  };
}

const SPAWN_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'task',
    description: 'Launch a new agent to handle a task.',
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string' },
        subagent_type: { type: 'string', enum: ['plan', 'build', 'critic'] },
        prompt: { type: 'string' },
      },
    },
  },
};
const VALID_SPEC_JSON = JSON.stringify({
  tool_name: 'task',
  arg_mapping: { title: 'description', type: 'subagent_type', prompt: 'prompt' },
  subagent_types: [
    { id: 'plan', description: 'Plans work' },
    { id: 'build', description: 'Builds things' },
    { id: 'critic', description: 'Evaluates results' },
  ],
  type_id: 'plan',
});

function makeState(overrides: Partial<LoopStateData> = {}): LoopStateData {
  const state = newLoopState({
    originalInstruction: 'Do the thing',
    internalMessages: [msg('user', 'Do the thing')],
    max_rounds: 2,
    tools: [SPAWN_TOOL],
    spec: null,
    context_window_size: 10000,
  });
  state.spec = {
    toolName: 'task',
    argMapping: { title: 'description', type: 'subagent_type', prompt: 'prompt' },
    availableTypes: [
      { id: 'plan', description: 'Plans work' },
      { id: 'build', description: 'Builds things' },
      { id: 'critic', description: 'Evaluates results' },
    ],
    typeId: 'plan',
  };
  state.activeTypeId = state.spec.typeId;
  return { ...state, ...overrides };
}

describe('contextFull (client-delegated compaction threshold)', () => {
  it('is disabled (false) when the window is unknown (windowSize <= 0)', () => {
    expect(contextFull({ prompt_tokens: 1_000_000 }, 0, 0.9)).toBe(false);
    expect(contextFull({ prompt_tokens: 1_000_000 }, -1, 0.9)).toBe(false);
  });

  it('is disabled (false) when no real usage was reported by the upstream', () => {
    expect(contextFull(undefined, 10000, 0.9)).toBe(false);
    expect(contextFull(null, 10000, 0.9)).toBe(false);
  });

  it('fires at the threshold and below-threshold stays clean', () => {
    expect(contextFull({ prompt_tokens: 8999 }, 10000, 0.9)).toBe(false);
    expect(contextFull({ prompt_tokens: 9000 }, 10000, 0.9)).toBe(true);
    expect(contextFull({ prompt_tokens: 9500 }, 10000, 0.9)).toBe(true);
  });
});

describe('isCompactionRequest (client compaction detection)', () => {
  it('detects the OpenCode/continuation-summary markers in the last user message', () => {
    expect(isCompactionRequest([msg('user', 'Please compact. Here is the conversation so far:\n...')])).toBe(true);
    expect(isCompactionRequest([msg('user', 'Write a continuation summary of the transcript below.')])); // Stainless
    expect(isCompactionRequest([msg('user', 'Here is the conversation so far:')])).toBe(true);
  });

  it('ignores ordinary requests (and empty input)', () => {
    expect(isCompactionRequest([msg('user', 'Build the feature')])).toBe(false);
    expect(isCompactionRequest([])).toBe(false);
  });

  it('only the LAST user message counts (an older mention is not a compaction request)', () => {
    const pile = [msg('user', 'Here is the conversation so far: (old)'), msg('assistant', 'ok'), msg('user', 'Build the feature')];
    expect(isCompactionRequest(pile)).toBe(false);
  });
});

describe('orchestrator — client-delegated compaction (compactPending)', () => {
  it('start(): a full-context interpret sets compactPending, relays the usage and still emits the spawn', async () => {
    const provider = withUsage(withMapping(stub(), VALID_SPEC_JSON), FULL_USAGE);
    const orchestrator = new SubagentOrchestrator(provider, log, 0.9);
    const state = makeState();
    const out = await orchestrator.start({ state, sessionId: 'ses_c1', model: 'm' });
    expect(out).not.toBeNull();
    expect(out!.outcome.kind).toBe('tool_call');
    expect(state.compactPending).toBe(true);
    expect(out!.outcome.usage).toEqual(FULL_USAGE);
    expect(state.lastUsage).toEqual(FULL_USAGE);
  });

  it('runSubagentPhase(): compactPending PRE-BLOCKS the phase — no upstream call, notice reply', async () => {
    const provider = stub() as ChatProvider & { calls: Array<{ model: string | null; messages: UpstreamMessage[] }> };
    const orchestrator = new SubagentOrchestrator(provider, log, 0.9);
    const state = makeState({ stage: 'planify', compactPending: true, lastUsage: FULL_USAGE, pendingAgentId: 'ag_c1', activeTypeId: 'plan' });
    const out = await orchestrator.runSubagentPhase({
      state,
      binding: { agentId: 'ag_c1', phase: 'planify' },
      model: 'm',
    });
    expect(provider.calls).toHaveLength(0); // NO upstream call
    expect(out.content).toBe(COMPACT_PENDING_NOTICE);
    expect(out.compactPending).toBe(true);
    expect(out.usage).toEqual(FULL_USAGE);
  });

  it('runSubagentPhase(): usage at the threshold interrupts — notice, compactPending, NO phase result stored', async () => {
    const provider = withUsage(stub(), FULL_USAGE) as unknown as ChatProvider & { calls: Array<{ model: string | null; messages: UpstreamMessage[] }> };
    const orchestrator = new SubagentOrchestrator(provider, log, 0.9);
    const state = makeState({ stage: 'planify', pendingAgentId: 'ag_c2' });
    const out = await orchestrator.runSubagentPhase({
      state,
      binding: { agentId: 'ag_c2', phase: 'planify' },
      model: 'm',
    });
    expect(provider.calls).toHaveLength(1);
    expect(out.content).toBe(COMPACT_PENDING_NOTICE);
    expect(out.compactPending).toBe(true);
    expect(state.compactPending).toBe(true);
    expect(state.lastUsage).toEqual(FULL_USAGE);
    expect(state.phaseResults['ag_c2']).toBeUndefined(); // the interrupted phase stored nothing
  });

  it('runSubagentPhase(): usage under the threshold stores the result as usual (no interrupt)', async () => {
    const provider = withUsage(stub(), HALF_USAGE) as unknown as ChatProvider & { calls: Array<{ model: string | null; messages: UpstreamMessage[] }> };
    const orchestrator = new SubagentOrchestrator(provider, log, 0.9);
    const state = makeState({ stage: 'planify', pendingAgentId: 'ag_c3' });
    const out = await orchestrator.runSubagentPhase({
      state,
      binding: { agentId: 'ag_c3', phase: 'planify' },
      model: 'm',
    });
    expect(out.compactPending).toBe(false);
    expect(state.compactPending).toBe(false);
    expect(state.phaseResults['ag_c3']).toBeDefined();
  });

  it('resume(): compactPending + compacted pile -> discards old context, clears the flag and re-emits a FRESH spawn', () => {
    const orchestrator = new SubagentOrchestrator(stub(), log, 0.9);
    const state = makeState({
      stage: 'execute',
      compactPending: true,
      lastUsage: FULL_USAGE,
      pendingAgentId: 'ag_old',
      activeTypeId: 'plan',
    });
    state.phaseResults['ag_old'] = COMPACT_PENDING_NOTICE; // the pause notice (never a real result)
    // The compacted pile: small enough to be far under the threshold.
    const compacted: UpstreamMessage[] = [msg('user', 'Summarized conversation: build the feature, plan drafted, execute in progress.')];
    const out = orchestrator.resume(state, 'ses_c4', compacted);
    expect(state.compactPending).toBe(false);
    expect(state.lastMessage).toBe('');
    expect(state.phaseResults['ag_old']).toBeUndefined(); // stale notice discarded
    expect(state.internalMessages).toEqual(compacted); // old pile discarded, new pile adopted
    expect(out.kind).toBe('tool_call');
    expect(out.usage).toEqual(FULL_USAGE); // real usage still relayed to the client
    expect(out.toolCall).toBeDefined();
    expect(state.pendingAgentId).not.toBe('ag_old'); // fresh agent id
  });

  it('resume(): compactPending + still-full pile -> keeps the flag and re-emits the SAME spawn (stable agent_id)', () => {
    const orchestrator = new SubagentOrchestrator(stub(), log, 0.9);
    const big = 'x'.repeat(45_000); // ~11k tokens estimated, window=10000 x 0.9 = 9000
    const state = makeState({
      stage: 'execute',
      compactPending: true,
      lastUsage: FULL_USAGE,
      pendingAgentId: 'ag_stable',
      activeTypeId: 'plan',
    });
    const stillFull: UpstreamMessage[] = [msg('user', `Here is the conversation so far:\n${big}`)];
    const out = orchestrator.resume(state, 'ses_c5', stillFull);
    expect(state.compactPending).toBe(true);
    expect(out.kind).toBe('tool_call');
    expect(state.pendingAgentId).toBe('ag_stable'); // stable re-emission
    expect(out.toolCall!.id).toBe('spawn_ag_stable');
  });

  it('resume(): a plain (non-pending) resume is unaffected by the compaction fields', () => {
    const orchestrator = new SubagentOrchestrator(stub(), log, 0.9);
    const state = makeState({ stage: 'planify', pendingAgentId: 'ag_p1' });
    state.phaseResults['ag_p1'] = JSON.stringify({ description: 'Take a concrete step' });
    const out = orchestrator.resume(state, 'ses_c6');
    expect(out.kind).toBe('tool_call');
    expect(state.compactPending).toBe(false);
    expect(state.stage).toBe('execute');
    expect(out.usage).toBeNull();
  });
});

describe('AgentLoop (inline) — context_full interrupts the loop for client compaction', () => {
  it('a full-context interpret stops before any further call and relays the real usage', async () => {
    const provider = withUsage(stub(), FULL_USAGE) as unknown as ChatProvider & { calls: Array<{ model: string | null; messages: UpstreamMessage[] }> };
    const loop = new AgentLoop(provider, undefined, {
      context_window_size: 10000,
      compact_threshold: 0.9,
      model: 'm',
    });
    const { decision, finalResult } = await loop.run('Do the thing', [msg('user', 'Do the thing')]);
    expect(decision).toBe('context_compact_pending');
    // Only the interpret call ran — planify/execute/evaluate were never attempted.
    expect(provider.calls).toHaveLength(1);
    expect(finalResult.usage).toEqual(FULL_USAGE);
    expect(finalResult.final_output).toBe(COMPACT_PENDING_NOTICE);
    expect(finalResult.decision).toBe('context_compact_pending');
  });

  it('under the threshold the loop runs normally and the usage still rides the result', async () => {
    const provider = withUsage(stub({ evalComplete: true }), HALF_USAGE) as unknown as ChatProvider & { calls: Array<{ model: string | null; messages: UpstreamMessage[] }> };
    const loop = new AgentLoop(provider, undefined, {
      context_window_size: 10000,
      compact_threshold: 0.9,
      model: 'm',
    });
    const { decision, finalResult } = await loop.run('Do the thing', [msg('user', 'Do the thing')]);
    expect(decision).toBe('complete');
    expect(finalResult.usage).toEqual(HALF_USAGE);
    expect(finalResult.final_output).not.toBe(COMPACT_PENDING_NOTICE);
  });
});
