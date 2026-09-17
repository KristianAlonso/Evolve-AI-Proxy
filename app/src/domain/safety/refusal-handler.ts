// Refusal handling (FR-013 / SC-020).
// When the upstream model refuses, extract the refusal reason and build a reformulated
// instruction that removes or reframes the offending element so the loop can retry.

/** Structured result of resolving a refusal. */
export interface RefusalResolution {
  reason: string;          // extracted cause (reasons array joined) or '' when unknown
  retryInstruction: string; // reformulated instruction to attempt again
}

/** Extract the refusal reason from the provider's normalized reasoning/usage (SC-020). */
export function extractRefusalReason(result: {
  reasoning?: string | null;
  error?: Record<string, unknown>;
}): string {
  if (result.reasoning) return result.reasoning.trim();

  const err = result.error as Record<string, unknown> | undefined;
  if (err && typeof err.message === 'string') return err.message.trim();
  return '';
}

/** Build a retry instruction that removes/reframes the offending part of the original request. SC-020. */
export function buildRetryInstruction(original: string, reason: string): RefusalResolution {
  const reasonSummary = reason || 'the model flagged content as non-compliant';
  return {
    reason,
    retryInstruction: [
      'Original instruction:',
      ` ${original}`,
      '',
      'The previous attempt was refused because:',
      ` ${reasonSummary}`,
      '',
      'Try again: keep the same goal but remove or reframe any element that triggered the refusal. If nothing can be reframed, explain what could be attempted instead.',
    ].join('\n'),
  };
}
