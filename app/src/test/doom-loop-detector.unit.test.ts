import { describe, it, expect } from 'vitest';
import { detectDoomLoop } from '../domain/safety/doom-loop-detector.js';

describe('detectDoomLoop (SC-012)', () => {
  it('detects a repeated phrase above the default threshold of 4', () => {
    const text = 'one two three four '.repeat(5); // phrase ≥8 chars, 4 tokens, repeats 5x -> detected
    const res = detectDoomLoop(text);
    expect(res.detected).toBe(true);
    expect(res.repetitions).toBeGreaterThanOrEqual(4);
  });

  it('does not flag distinct output as a doom loop', () => {
    const text = ['first second third fourth fifth sixth seventh eighth'].join(' ');
    const res = detectDoomLoop(text, 4);
    expect(res.detected).toBe(false);
    expect(res.repetitions).toBeLessThan(4);
  });

  it('respects a custom higher threshold', () => {
    // only 3 consecutive repeats; below the default 4 but above... still below.
    const text = 'aaa bbb '.repeat(2) + 'bbb'; // one phrase x 3
    expect(detectDoomLoop(text, 6).detected).toBe(false);
  });

  it('handles empty/invalid input without throwing', () => {
    expect(detectDoomLoop('', 4)).toEqual({ detected: false, repetitions: 0 });
    expect(detectDoomLoop(null, 4).detected).toBe(false);
  });
});
