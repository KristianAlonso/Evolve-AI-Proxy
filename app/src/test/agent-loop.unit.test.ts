// Unit tests for the agent loop orchestrator (ADR A-003) against a stub provider.
// Exercises: complete decision, max-rounds abort, and client-disconnect abort (SC-023).

import { describe, it, expect } from 'vitest';
import { AgentLoop } from '../core/agent-loop.js';
import type { ChatProvider } from '../provider/types.js';
import type { LoopSink } from '../core/agent-loop.js';
import type { ToolCall } from '../types.js';
import { stub, streamingStub } from './stub-provider.js';

/** Records phases and live-reasoning deltas so we can assert the interpret -> execute -> evaluate sequence. */
class TestSink implements LoopSink {
  public readonly phases: string[] = [];
  /** Live reasoning deltas streamed during an attempt (populated only when streaming). */
  public readonly thinking: string[] = [];
  private _disconnected = false;
  isDisconnected() { return this._disconnected; }
  disconnect() { this._disconnected = true; }
  emitReasoning(): void {}
  emitReasoningDelta(_iteration: number, delta: string): void { if (delta) this.thinking.push(delta); }
  /** Assistant content streamed on the dual path lands in the same recorded deltas. */
  emitContent(_iteration: number, text: string): void { if (text) this.thinking.push(text); }
  writeEvent(ev: string): void { if (ev === 'context_clear') this.phases.push('clear'); }
  emitPhase(p: string) { this.phases.push(p); }
  public readonly toolCalls: ToolCall[] = [];
  emitToolCalls(calls: ToolCall[]): void { this.toolCalls.push(...calls); }
}

describe('AgentLoop', () => {
  it('decides complete after one task when the evaluator approves (SC-007)', async () => {
    const provider = stub({ evalComplete: true });
    const sink = new TestSink();
    const loop = new AgentLoop(provider as ChatProvider, sink);
    const { decision, finalResult } = await loop.run('make a thing', [
      { role: 'user', content: 'make a thing' },
    ]);

    expect(decision).toBe('complete');
    // interpreter -> generateTasks(0 calls) -> 1 execute -> 1 evaluate.
    expect(provider.calls.length).toBeGreaterThanOrEqual(2);
    expect(finalResult.iterations_completed).toBe(1);
    expect(sink.phases.includes('interpreting')).toBe(true);
    expect(sink.phases.includes('completed')).toBe(true);
  });

  it('aborts with max_rounds_exceeded when evaluation keeps continuing (SC-017)', async () => {
    const provider = stub({ evalComplete: false }); // evaluator always says "continue"
    const loop = new AgentLoop(provider as ChatProvider, undefined, { max_rounds: 2 });
    const { decision } = await loop.run('loop forever', [{ role: 'user', content: 'loop forever' }]);
    expect(decision).toBe('max_rounds_exceeded');
    // 2 rounds × (1 execute + 1 evaluate) calls.
    expect(provider.calls.length).toBe(4);
  });

  it('aborts immediately on client disconnect (SC-023)', async () => {
    const provider = stub({ evalComplete: true, output: 'partial' });
    const sink = new TestSink();
    sink.disconnect(); // pretend the client already dropped
    const loop = new AgentLoop(provider as ChatProvider, sink);
    const { decision } = await loop.run('do work', [{ role: 'user', content: 'do work' }]);
    expect(decision).toBe('continue'); // broke out of the loop without doing anything
    expect(provider.calls.length).toBe(0);
  });

  it('streams live reasoning deltas from interpret AND eval phases (FASE 1)', async () => {
    const provider = streamingStub({ evalComplete: true });
    const sink = new TestSink();
    const loop = new AgentLoop(provider as ChatProvider, sink);
    const { decision } = await loop.run('stream it', [{ role: 'user', content: 'stream it' }]);

    expect(decision).toBe('complete');
    // The VERY FIRST delta on the wire is the interpret phase announcement: the client sees each
    // phase starting and what it is about to do BEFORE the upstream call (real-time, no custom
    // event types — just reasoning deltas on the OpenAI wire).
    expect(sink.thinking[0]).toBe('[interpret] analyzing the request to derive the objective and sub-objectives\n');
    // Every subsequent phase announces itself the same way…
    // Execute output and evaluator reasoning also arrived as live deltas (not one late blob).
    const all = sink.thinking.join('');
    expect(all).toContain('[execute] executing: '); // announces the concrete task
    expect(all).toContain('[evaluate] checking whether the original goal has been met\n');
    expect(all).toContain('interpreted');
    expect(all).toContain('Task succeeded.');
    expect(all).toContain('yes');
  });

  it('delegates tool calls to the client and pauses with tool_calls_pending (FASE 2)', async () => {
    const calls: ToolCall[] = [
      { id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"q":"proxy"}' } },
      { id: 'call_2', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } },
    ];
    const provider = stub({ evalComplete: true, toolCalls: calls });
    const sink = new TestSink();
    const loop = new AgentLoop(provider as ChatProvider, sink, { tools: [{ type: 'function', function: { name: 'search' } }] });
    const { decision, finalResult } = await loop.run('find something', [
      { role: 'user', content: 'find something' },
    ]);

    expect(decision).toBe('tool_calls_pending');
    expect(finalResult.tool_calls).toEqual(calls);
    // The sink received both calls, in order.
    expect(sink.toolCalls).toEqual(calls);
  });

  it('surfaces streamed tool calls via the sink (FASE 2 streaming path)', async () => {
    const calls: ToolCall[] = [
      { id: 'call_stream', type: 'function', function: { name: 'list_dir', arguments: '{"path":"."}' } },
    ];
    const provider = streamingStub({ evalComplete: true, toolCalls: calls });
    const sink = new TestSink();
    const loop = new AgentLoop(provider as ChatProvider, sink);
    const { decision, finalResult } = await loop.run('ls the cwd', [
      { role: 'user', content: 'ls the cwd' },
    ]);

    expect(decision).toBe('tool_calls_pending');
    expect(finalResult.tool_calls).toEqual(calls);
    expect(sink.toolCalls).toEqual(calls);
  });

  it('propagates a thrown error as decision=error (SC-014 failure path)', async () => {
    const throwing: ChatProvider = {
      async listModels() { return []; },
      async complete() { throw new Error('upstream blew up'); },
    };
    const loop = new AgentLoop(throwing, undefined);
    const { decision } = await loop.run('explode', [{ role: 'user', content: 'explode' }]);
    expect(decision).toBe('error');
  });
});
