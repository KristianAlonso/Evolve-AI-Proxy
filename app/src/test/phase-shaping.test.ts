// ADR A-008 — phase-prompt shaping rules, verified at the prompt level:
//
//   1) The client's system message is preserved as-is (first, verbatim); the proxy NEVER adds
//      system messages.
//   2) Every new instruction the proxy adds is a `user`-role message APPENDED at the end.
//   3) Intermediate messages generated/received through the API are NOT kept: the prompt carries
//      at most ONE `assistant` intermediate turn (the last phase output) plus the final
//      `user` instruction.
//
// Uses the in-memory stub (no network): the stub's `calls` record every upstream message array,
// so the assertions inspect EXACTLY what the proxy would have sent upstream.

import { describe, it, expect } from 'vitest';
import { AgentLoop, type LoopOptions } from '../core/agent-loop.js';
import { SubagentOrchestrator } from '../core/orchestrator.js';
import { stub, type StubRecord } from './stub-provider.js';
import { createLogger } from '../logger.js';
import type { ChatProvider } from '../provider/types.js';
import type { LoopStateData } from '../core/loop-state.js';
import type { SubagentSpawnSpec } from '../core/subagent-spawn.js';
import type { UpstreamMessage } from '../types.js';

const SYSTEM = 'You are a helpful assistant working on this project.';

const clientMessages = (): UpstreamMessage[] => [
  { role: 'system', content: SYSTEM },
  { role: 'user', content: 'Build the feature' },
];

const INTERP_RAW = '{"mainObjective":"Complete the task","subObjectives":[],"resourcesNeeded":[]}';

function lastPhaseUser(prompt: UpstreamMessage[]): string {
  return String(prompt[prompt.length - 1].content ?? '');
}

function loopOptions(max_rounds: number): Partial<LoopOptions> {
  return { max_rounds, max_retries: 0, doom_loop_threshold: 5, context_window_size: 0 };
}

describe('ADR A-008 — phase-prompt shaping (inline AgentLoop)', () => {
  it('keeps the client system message verbatim and adds no system messages (all phases)', async () => {
    const provider = stub({ evalComplete: false }) as unknown as ChatProvider & { calls: StubRecord[] };

    const loop = new AgentLoop(provider, undefined, loopOptions(2));
    const { decision } = await loop.run('Build the feature', clientMessages());
    expect(decision).toBe('max_rounds_exceeded');

    // Every single upstream call of the run:
    // - the client system message is the FIRST message, byte-identical;
    // - the proxy NEVER adds a system message (at most the single client one);
    // - the client `user` request stays at its original index (1);
    // - every phase prompt ENDS on a user-role instruction (proxy content appended at the end).
    for (const call of provider.calls) {
      expect(call.messages[0].role).toBe('system');
      expect(call.messages[0].content).toBe(SYSTEM);
      expect(call.messages.filter((m) => m.role === 'system')).toHaveLength(1);
      expect(call.messages[1]).toMatchObject({ role: 'user', content: 'Build the feature' });
      expect(call.messages[call.messages.length - 1].role).toBe('user');
    }
  });

  it('keeps only the LAST intermediate message — earlier phase outputs are discarded', async () => {
    const provider = stub({ evalComplete: true }) as unknown as ChatProvider & { calls: StubRecord[] };

    const loop = new AgentLoop(provider, undefined, loopOptions(1));
    const { decision } = await loop.run('Build the feature', clientMessages());
    expect(decision).toBe('complete');

    const [interpret, execute, evaluate] = provider.calls;
    // Interpret: base(2) + user instruction = 3. (No intermediate yet.)
    expect(interpret.messages.map((m) => m.role)).toEqual(['system', 'user', 'user']);
    // Execute: base(2) + ONE assistant (the interpret raw) + user instruction.
    expect(execute.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(execute.messages[2].content).toBe(INTERP_RAW);
    // Evaluate: base(2) + ONE assistant (the execute raw output) + user instruction.
    expect(evaluate.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(evaluate.messages[2].content).toBe('Task succeeded.');
    // The interpret intermediate output was DISCARDED by the evaluate prompt (only the last one).
    const evaluateText = evaluate.messages.map((m) => m.content ?? '').join('\n');
    expect(evaluateText).not.toContain('mainObjective');
    // No phase prompt ever carries MORE than one intermediate assistant turn.
    for (const call of provider.calls) {
      expect(call.messages.filter((m) => m.role === 'assistant').length).toBeLessThanOrEqual(1);
    }
  });

  it('multi-round: each round re-enters on the previous turn\'s LAST message only', async () => {
    const provider = stub({ evalComplete: false }) as unknown as ChatProvider & { calls: StubRecord[] };

    // max_rounds=4 -> two full loop iterations (the loop body advances `round` twice per turn).
    const loop = new AgentLoop(provider, undefined, loopOptions(4));
    await loop.run('Build the feature', clientMessages());

    const calls = provider.calls;
    // 2 iterations:
    //   [0] interp, [1] exec, [2] eval(continue), [3] planify (queue replenish),
    //   [4] interp, [5] planify (tasks[round] exhausted), [6] exec, [7] eval, [8] planify (replenish)
    expect(calls.length).toBe(9);
    const [interp1, , , , interp2, , exec2, eval2] = calls;

    // Round 2 interpret: base(2) + ONE assistant = the LAST phase output of the previous turn —
    // the queue-replenish planify raw (which runs after evaluate). Everything before it (interpret,
    // execute, evaluate) is gone: only the last intermediate message survives, per A-008.
    expect(interp2.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(interp2.messages[2].content).toBe('Take the next step toward the goal.');
    // Round 2 execute: base(2) + ONE assistant = the round-2 planify raw (its last message).
    expect(exec2.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(exec2.messages[2].content).toBe('Take the next step toward the goal.');
    // Every round-2 prompt still starts with the untouched client base and ends on a user instruction.
    for (const call of [interp1, interp2, exec2, eval2]) {
      expect(call.messages[0].content).toBe(SYSTEM);
      expect(call.messages[1].content).toBe('Build the feature');
      expect(call.messages[call.messages.length - 1].role).toBe('user');
    }
  });

  it('orchestrator delegated phase: same shaping — base verbatim + last assistant + user instruction', async () => {
    const provider = stub() as unknown as ChatProvider & { calls: StubRecord[] };
    const spec: SubagentSpawnSpec = {
      toolName: 'task',
      argMapping: { title: 'title', type: 'type', prompt: 'prompt' },
      availableTypes: [{ id: 'default', description: '' }],
      typeId: 'default',
    };
    const orch = new SubagentOrchestrator(provider, createLogger('test'));
    const state: LoopStateData = {
      stage: 'execute',
      round: 1,
      max_rounds: 3,
      originalInstruction: 'Build the feature',
      internalMessages: clientMessages(),
      spec,
      activeTypeId: 'default',
      spawnRetries: 0,
      interpretation: null,
      task: null,
      lastOutput: '',
      lastMessage: 'The planify phase finished proposing a task.',
      context_window_size: 0,
      fellBackToRendered: false,
      accumulatedSteps: [],
      phaseResults: {},
      pendingAgentId: 'ag_1',
      decision: null,
      finalOutput: '',
      totalUpstreamCalls: 0,
      compactPending: false,
      lastUsage: null,
    };

    await orch.runSubagentPhase({
      state,
      binding: { agentId: 'ag_1', phase: 'execute' },
      model: 'llama_cpp/default',
      tools: [{ type: 'function', function: { name: 'shell', description: '' } }],
      tool_choice: 'auto',
    });

    expect(provider.calls).toHaveLength(1);
    const prompt = provider.calls[0].messages;
    // Client base verbatim first…
    expect(prompt[0]).toMatchObject({ role: 'system', content: SYSTEM });
    expect(prompt[1]).toMatchObject({ role: 'user', content: 'Build the feature' });
    // …then the ONLY intermediate: the last phase output, as a single assistant turn…
    expect(prompt[2].role).toBe('assistant');
    expect(prompt[2].content).toBe('The planify phase finished proposing a task.');
    // …then the execute instruction appended last (user role, no system anywhere else).
    expect(prompt[prompt.length - 1].role).toBe('user');
    expect(prompt.filter((m) => m.role === 'system')).toHaveLength(1);
    expect(prompt.filter((m) => m.role === 'assistant')).toHaveLength(1);
  });

  it('the appended instructions are the phase wordings (interpreter/evaluate regexes preserved)', async () => {
    const provider = stub({ evalComplete: true }) as unknown as ChatProvider & { calls: StubRecord[] };
    const loop = new AgentLoop(provider, undefined, loopOptions(1));
    await loop.run('Build the feature', clientMessages());

    const [interpret, , evaluate] = provider.calls;
    expect(lastPhaseUser(interpret.messages)).toContain('You are the interpreter of an agent loop proxy');
    expect(lastPhaseUser(evaluate.messages)).toContain('Reply with EXACTLY one of');
    expect(lastPhaseUser(evaluate.messages)).toContain('Original instruction: Build the feature');
  });
});
