// Unit tests for the agent loop orchestrator (ADR A-003) against a stub provider.
// Exercises: complete decision, max-rounds abort, and client-disconnect abort (SC-023).

import { describe, it, expect } from 'vitest';
import { AgentLoop } from '../core/agent-loop.js';
import type { ChatProvider } from '../provider/types.js';
import type { LoopSink } from '../core/agent-loop.js';
import { stub } from './stub-provider.js';

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
