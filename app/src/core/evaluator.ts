// Binary auto-evaluation phase (FR-004 / SC-007, SC-008).
// Asks the model whether a task is complete and normalizes the answer to yes/no.

import type { ChatProvider } from '../provider/types.js';
import type { NormalizedResult, UpstreamMessage } from '../types.js';
import { callWithStreaming, type LiveEmitter } from './stream-helper.js';
import type { TraceLogger } from '../logger.js';

const YES_PATTERNS = /(^|[\s([:punct:]])yes|true|completed|done|complete|sí|si[^l]|affirmative|correcta(?:mente)?/i;
const NO_PATTERNS = /\bno\b|false|not complete|incomplete|no\b.*still|\bsimilar\b/i;

/** Classify a raw model answer into 'complete' | 'continue'. Anything unclassifiable -> continue (SC-008). */
export function classifyEvaluation(answer: string): { decision: 'complete' | 'continue'; normalized: string } {
  const clean = String(answer || '').trim().toLowerCase();
  if (!clean) return { decision: 'continue', normalized: '' };

  const isYes = YES_PATTERNS.test(clean);
  const isNo = NO_PATTERNS.test(clean);

  // Explicit no wins only when there is an unambiguous negative word (so "no it's not done").
  if (isNo && !isYes) return { decision: 'continue', normalized: 'no' };
  if (isYes && !isNo) return { decision: 'complete', normalized: 'yes' };
  // Ambiguous or contains both -> default to continue.
  return { decision: isYes ? 'complete' : 'continue', normalized: clean.slice(0, 240) };
}

/** Run the binary evaluation against the model. ADR A-008: the caller builds the FULL prompt
 *  (`buildPhasePrompt(base, lastMessage, buildEvaluateInstruction(originalInstruction))`) — the
 *  task result is the assistant message right before the instruction. No system message is added
 *  here; the raw answer is returned (`raw`) so the caller can keep it as the last intermediate
 *  message of the process. */
export async function evaluateTask(
  provider: ChatProvider,
  messages: UpstreamMessage[],
  options?: { model: string | null; logger?: TraceLogger; traceId?: string; abort_signal?: AbortSignal; passthrough?: Record<string, unknown> },
  emitter?: LiveEmitter,
): Promise<{ decision: 'complete' | 'continue'; reasoning: string; raw: string; streamed: boolean; usage: NormalizedResult['usage'] }> {
  const { result, streamed } = await callWithStreaming({
    provider,
    model: options?.model ?? null, // concrete user-selected model — never "auto" (no-auto rule)
    messages,
    // ADR A-007 (passthrough-intacto): no invented max_tokens budget — the client's request
    // parameters are forwarded exactly as sent; no client value means no field in the upstream call.
    options: { passthrough: options?.passthrough, logger: options?.logger, trace_id: options?.traceId, abort_signal: options?.abort_signal },
    surfaceDelta: emitter ? (chunk) => {
      const reasoning = typeof chunk.reasoning === 'string' ? chunk.reasoning : '';
      if (reasoning !== '') emitter.emitReasoningDelta(0, reasoning);
    } : undefined,
  });
  const raw = result.content?.trim() || '';
  // If the model produced no usable content, treat as "continue".
  if (!raw) return { decision: 'continue', reasoning: result.reasoning, raw, streamed, usage: result.usage };

  const classification = classifyEvaluation(raw);
  return {
    decision: classification.decision,
    reasoning: `${result.reasoning}\nnormalized: ${classification.normalized}`,
    raw,
    streamed,
    usage: result.usage,
  };
}
