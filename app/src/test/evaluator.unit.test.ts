// Unit tests for classifyEvaluation (domain/evaluator.ts).
//
// Regression: the evaluate instruction asks for EXACTLY `{"complete": true}` /
// `{"complete": false}`. The old word-regex matched "complete" inside the JSON KEY NAME and
// the both-signal tie-break defaulted to 'complete', so `{"complete": false}` classified as
// complete — the live loop stopped even though the evaluator said the task was NOT done.
// JSON-first parsing must make the instructed format authoritative, and any genuinely
// ambiguous answer must default to 'continue' (SC-008).

import { describe, it, expect } from 'vitest';
import { classifyEvaluation } from '../domain/evaluator.js';

describe('classifyEvaluation', () => {
  it('trusts the instructed JSON format over words (complete=false -> continue)', () => {
    expect(classifyEvaluation('{"complete": false}').decision).toBe('continue');
    expect(classifyEvaluation('{"complete": true}').decision).toBe('complete');
  });

  it('handles JSON wrapped in prose / markdown fences', () => {
    expect(classifyEvaluation('The task is not finished: {"complete": false}').decision).toBe('continue');
    expect(classifyEvaluation('```json\n{"complete": true}\n```').decision).toBe('complete');
  });

  it('handles JSON with a string-valued complete field', () => {
    expect(classifyEvaluation('{"complete": "false"}').decision).toBe('continue');
    expect(classifyEvaluation('{"complete": "true"}').decision).toBe('complete');
  });

  it('handles JSON with the key but unparseable body by falling back to words', () => {
    // `complete: false` without braces -> word heuristic: "false" only, no yes-word.
    expect(classifyEvaluation('complete: false').decision).toBe('continue');
  });

  it('still classifies plain-language answers (non-JSON replies)', () => {
    expect(classifyEvaluation('yes').decision).toBe('complete');
    expect(classifyEvaluation('No, not complete').decision).toBe('continue');
    expect(classifyEvaluation('done').decision).toBe('complete');
    expect(classifyEvaluation('incomplete — still pending').decision).toBe('continue');
    expect(classifyEvaluation('Sí, completed correctly').decision).toBe('complete');
  });

  it('defaults ambiguous or empty answers to continue (SC-008 — never end on a guess)', () => {
    expect(classifyEvaluation('').decision).toBe('continue');
    expect(classifyEvaluation('maybe').decision).toBe('continue');
    // Both a yes-word and a no-word present -> ambiguous -> continue (NOT complete).
    expect(classifyEvaluation('no, still pending').decision).toBe('continue');
  });

  it('classifies the awaiting_user contract (work blocked on user input)', () => {
    expect(classifyEvaluation('{"complete": false, "awaiting_user": true}').decision).toBe('awaiting_user');
    expect(classifyEvaluation('Blocked on a user decision:\n{"complete": false, "awaiting_user": true}').decision).toBe('awaiting_user');
    // awaiting_user wins over complete (the contract forbids the combination, but the flag is
    // authoritative when present).
    expect(classifyEvaluation('{"complete": true, "awaiting_user": true}').decision).toBe('awaiting_user');
    // Bare complete-JSON stays unchanged.
    expect(classifyEvaluation('{"complete": false}').decision).toBe('continue');
    expect(classifyEvaluation('{"complete": true}').decision).toBe('complete');
  });
});
