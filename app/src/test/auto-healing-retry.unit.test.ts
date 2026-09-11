import { describe, it, expect } from 'vitest';
import { withAutoHealingRetry, buildAutocorrectPrompt } from '../safety/auto-healing-retry.js';

describe('withAutoHealingRetry (SC-013/014)', () => {
  it('returns a completed result when the first attempt succeeds', async () => {
    let calls = 0;
    const outcome = await withAutoHealingRetry(async () => {
      calls += 1;
      return { output: 'ok', reasoning: '' };
    }, { maxRetries: 3 });

    expect(calls).toBe(1);
    expect(outcome.result.status).toBe('completed');
    expect(outcome.result.attempts).toBe(1);
    expect(outcome.traces.length).toBe(0);
  });

  it('retries a failing step and eventually completes', async () => {
    let calls = 0;
    const outcome = await withAutoHealingRetry(async () => {
      calls += 1;
      if (calls < 3) throw new Error('transient boom');
      return { output: 'recovered', reasoning: '' };
    }, { maxRetries: 3 });

    expect(calls).toBe(3);
    expect(outcome.result.status).toBe('completed');
    // two failed attempts are recorded as traces.
    expect(outcome.traces.length).toBe(2);
    expect(outcome.traces[0].error).toContain('transient boom');
  });

  it('fails with a partial result after exhausting retries', async () => {
    let calls = 0;
    const outcome = await withAutoHealingRetry(async () => {
      calls += 1;
      throw new Error(`fail #${calls}`);
    }, { maxRetries: 2 });

    expect(calls).toBe(3); // 1 initial + 2 retries
    expect(outcome.result.status).toBe('failed');
    expect(outcome.traces.length).toBe(2);
  });

  it('detects a doom-loop and still stops with a partial result', async () => {
    let calls = 0;
    const outcome = await withAutoHealingRetry(async () => {
      calls += 1;
      return { output: '', reasoning: 'd '.repeat(8) }; // single repeated token > threshold -> doomed (FR-007)
    }, { maxRetries: 2 });

    expect(calls).toBe(3); // loop flagged each time, retried, never completes cleanly
    expect(outcome.result.status).toBe('failed');
    expect(outcome.doomedLoop.detected).toBe(true);
  });
});

describe('buildAutocorrectPrompt', () => {
  it('names the specific error to avoid next run', () => {
    const prompt = buildAutocorrectPrompt('do X', 'null reference at line 3');
    expect(prompt).toContain('do X');
    expect(prompt).toContain('null reference at line 3');
  });
});
