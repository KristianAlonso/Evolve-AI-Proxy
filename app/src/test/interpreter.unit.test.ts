import { describe, it, expect } from 'vitest';
import { interpretRequest, formatInterpretationTrace } from '../core/interpreter.js';
import { buildPhasePrompt, INTERPRET_INSTRUCTION } from '../core/phase-prompts.js';
import type { ChatProvider } from '../provider/types.js';
import { resp } from './stub-provider.js';

const provider: ChatProvider = {
  async listModels() { return []; },
  async complete(_m, msgs) {
    const text = msgs.map((m) => m.content ?? '').join('\n');
    if (/interpreter of an agent loop/.test(text)) {
      return resp({ content: JSON.stringify({ mainObjective: 'Build X', subObjectives: ['a', 'b'], resourcesNeeded: ['db'] }), reasoning: 'r' });
    }
    return resp({ content: '', reasoning: '' });
  },
};

describe('interpreter (SC-003/004)', () => {
  it('parses a structured JSON interpretation', async () => {
    const { interpretation, reasoning } = await interpretRequest(provider, buildPhasePrompt([{ role: 'user', content: 'Build X' }], null, INTERPRET_INSTRUCTION), { model: null });
    expect(interpretation.mainObjective).toBe('Build X');
    expect(interpretation.subObjectives).toEqual(['a', 'b']);
    expect(interpretation.resourcesNeeded).toEqual(['db']);
    expect(reasoning).toBe('r');
  });

  it('falls back to mainObjective when the body is not JSON', async () => {
    const loose: ChatProvider = { ...provider, complete: async () => resp({ content: 'just a sentence with no braces' }) };
    const { interpretation } = await interpretRequest(loose, buildPhasePrompt([{ role: 'user', content: 'x' }], null, INTERPRET_INSTRUCTION), { model: null });
    expect(interpretation.mainObjective).toBe('just a sentence with no braces');
    expect(interpretation.subObjectives.length).toBe(0);
  });

  it('builds a readable trace body', () => {
    const trace = formatInterpretationTrace({ mainObjective: 'Build X', subObjectives: ['a'], resourcesNeeded: ['db'] });
    expect(trace).toContain('mainObjective: Build X');
    expect(trace).toContain('- a');
    expect(trace).toContain('- db');
  });
});
