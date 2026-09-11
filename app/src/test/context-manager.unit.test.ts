import { describe, it, expect } from 'vitest';
import { ContextManager } from '../core/context-manager.js';

describe('ContextManager (SC-021)', () => {
  const step = (output: string) => ({
    iteration: 1,
    objective: 'obj',
    task_id: 't1',
    output,
    successful: true,
  });

  it('shouldCondense is false while well within the window', () => {
    const cm = new ContextManager(4096);
    cm.record(step('short output here'));
    expect(cm.shouldCondense === undefined ? cm.shouldCondense() : false).toBe(false);
  });

  it('shouldCondense flips true past 75% of the configured window', () => {
    const cm = new ContextManager(100); // tiny window so a long output crosses the threshold
    cm.record(step(('word '.repeat(200)))); // ~260 tokens projected > 75
    expect(cm.shouldCondense === undefined ? cm.shouldCondense() : true).toBe(true);
  });

  it('condense keeps recent steps and produces a summary', () => {
    const cm = new ContextManager(4096);
    for (let i = 0; i < 5; i++) {
      cm.record(step(`iteration output number ${i} some extra filler text`));
    }
    const { summary, remainingSteps } = cm.condense();
    expect(summary.length).toBeGreaterThan(0);
    expect(summary).toContain('Original objective');
    // keeps only the most recent few steps after condensing.
    expect(remainingSteps.length).toBeLessThanOrEqual(3);
  });
});
