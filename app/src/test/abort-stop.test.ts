// Stop propagation (SC-023 complement): when the client interrupts the connection OR instructs
// the model to stop, the proxy must (1) cancel the IN-FLIGHT upstream call via AbortSignal — not
// just stop reading from it — and (2) halt the AgentLoop at its next checkpoint, without wasting
// retries on an already-aborted request.
//
// Both cases reduce to the same mechanism: routes.ts owns one AbortController per request and
// aborts it when reply.raw closes before the response ended (a disconnect, or a "stop" which the
// client implements by cutting the HTTP stream).

import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../core/agent-loop.js';
import { isAbortError } from '../provider/types.js';
import type { ChatProvider } from '../provider/types.js';
import { stub } from './stub-provider.js';

describe('stop propagation: client abort / model stop', () => {
  it('halts BEFORE any upstream call when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort('client stop');
    const provider = stub();
    const loop = new AgentLoop(provider as ChatProvider, undefined, {
      max_rounds: 5,
      context_window_size: 1000,
      abort_signal: controller.signal,
    });
    const { decision, finalResult } = await loop.run('hi', [{ role: 'user', content: 'hi' }]);
    expect(decision).toBe('error');
    // No upstream call may have been made for a dead client.
    expect(provider.calls.length).toBe(0);
    expect(finalResult.reasoning_traces_summary.total_upstream_calls).toBe(0);
  });

  it('cancels the in-flight upstream call and ends in error when the client aborts mid-run', async () => {
    const controller = new AbortController();
    const provider = stub();
    const loop = new AgentLoop(provider as ChatProvider, undefined, {
      max_rounds: 5,
      context_window_size: 1000,
      abort_signal: controller.signal,
    });
    const runP = loop.run('hi', [{ role: 'user', content: 'hi' }]);
    // Abort while the first upstream call (interpret) is still in flight: the stub's
    // respectAbort() rejects it with an AbortError, exactly like the real provider's fetch.
    controller.abort('user asked to stop');
    const { decision, finalResult } = await runP;
    expect(controller.signal.aborted).toBe(true);
    expect(decision).toBe('error');
    // The aborted call is counted (it left the proxy) but the loop did NOT retry it and did not
    // continue to further rounds.
    expect(finalResult.reasoning_traces_summary.total_upstream_calls).toBeLessThanOrEqual(2);
  });

  it('isAbortError recognises AbortError-shaped failures (duck-typed, cross-realm safe)', () => {
    const real = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    expect(isAbortError(real)).toBe(true);
    expect(isAbortError({ name: 'AbortError', message: '' })).toBe(true);
    expect(isAbortError({ message: 'This operation was aborted' })).toBe(true);
    expect(isAbortError(new Error('context window exceeded'))).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });
});
