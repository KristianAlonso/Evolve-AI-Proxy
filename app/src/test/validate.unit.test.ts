import { describe, it, expect } from 'vitest';
import { validateRequest } from '../domain/validation.js';

describe('validateRequest (SC-024)', () => {
  const valid = () => ({ model: 'gpt', messages: [{ role: 'user', content: 'hi' }] });

  it('accepts a well-formed body', () => {
    expect(validateRequest(valid()).ok).toBe(true);
  });

  it('reports BOTH missing model AND bad messages at once (SC-024)', () => {
    const res = validateRequest({});
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.field === 'model')).toBe(true);
      expect(res.issues.some((i) => i.field === 'messages')).toBe(true);
    }
  });

  it('rejects an empty messages array', () => {
    const res = validateRequest({ model: 'gpt', messages: [] });
    if (!res.ok) expect(res.issues.some((i) => i.message.includes('non-empty'))).toBe(true);
  });

  it('rejects every message with an invalid role', () => {
    const res = validateRequest({ model: 'gpt', messages: [{ role: 'banana', content: 'x' }] });
    if (!res.ok) expect(res.issues.some((i) => i.field.startsWith('messages[0].role'))).toBe(true);
  });

  it('requires at least one user/system message even if roles are valid', () => {
    const res = validateRequest({ model: 'gpt', messages: [{ role: 'tool', content: 'x' }] });
    if (!res.ok) expect(res.issues.some((i) => i.message.includes('user or system'))).toBe(true);
  });

  it('rejects a non-string message content', () => {
    const res = validateRequest({ model: 'gpt', messages: [{ role: 'user', content: 42 }] as any });
    if (!res.ok) expect(res.issues.some((i) => i.field === 'messages[0].content')).toBe(true);
  });

  it('rejects temperature outside 0..2', () => {
    const res = validateRequest({ ...valid(), temperature: 5 });
    if (!res.ok) expect(res.issues.some((i) => i.field === 'temperature')).toBe(true);
  });

  it('rejects non-integer / sub-one evolve controls', () => {
    expect(validateRequest({ ...valid(), max_rounds: 2.5 }).ok).toBe(false);
    expect(validateRequest({ ...valid(), max_retries: 0 }).ok).toBe(false);
  });
});
