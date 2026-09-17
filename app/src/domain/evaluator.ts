// Binary auto-evaluation phase (FR-004 / SC-007, SC-008).
// Asks the model whether a task is complete and normalizes the answer to yes/no.

import type { ChatProvider } from './provider/types.js';
import type { NormalizedResult, UpstreamMessage } from './types.js';
import { callWithStreaming, type LiveEmitter } from './stream-helper.js';
import type { TraceLogger } from './logging.js';

const YES_PATTERNS = /(^|[\s([:punct:]])yes|true|completed|done|complete|sí|si[^l]|affirmative|correcta(?:mente)?/i;
const NO_PATTERNS = /\bno\b|false|not complete|incomplete|no\b.*still|\bsimilar\b/i;

/** Classify a raw model answer into 'complete' | 'continue'. Anything unclassifiable -> continue (SC-008). */
export function classifyEvaluation(answer: string): { decision: 'complete' | 'continue'; normalized: string } {
  const clean = String(answer || '').trim().toLowerCase();
  if (!clean) return { decision: 'continue', normalized: '' };

  // The evaluate instruction asks for EXACTLY `{"complete": true}` / `{"complete": false}` — when
  // the reply is JSON, trust the `complete` field over any word heuristic. (The regex below would
  // otherwise match the word "complete" INSIDE THE KEY NAME and misclassify `{"complete": false}`
  // as complete — observed live: the loop stopped even though the evaluator said the task was NOT
  // done. JSON-first parsing makes the instructed format authoritative.)
  const jsonBrace = clean.match(/\{[\s\S]*\}/);
  if (jsonBrace) {
    try {
      const parsed: unknown = JSON.parse(jsonBrace[0]);
      if (parsed !== null && typeof parsed === 'object') {
        const v = (parsed as Record<string, unknown>).complete;
        if (typeof v === 'boolean') return { decision: v ? 'complete' : 'continue', normalized: 'json' };
        if (typeof v === 'string') {
          const s = v.trim();
          if (s === 'true' || s === 'yes') return { decision: 'complete', normalized: 'json' };
          if (s === 'false' || s === 'no') return { decision: 'continue', normalized: 'json' };
        }
      }
    } catch {
      // not valid JSON — fall through to the word heuristic
    }
  }

  const isYes = YES_PATTERNS.test(clean);
  const isNo = NO_PATTERNS.test(clean);

  // Explicit no wins only when there is an unambiguous negative word (so "no it's not done").
  if (isNo && !isYes) return { decision: 'continue', normalized: 'no' };
  if (isYes && !isNo) return { decision: 'complete', normalized: 'yes' };
  // Ambiguous (both signals, or neither) -> default to continue (SC-008: never end the loop on a
  // guess — an extra round is cheap, a premature 'complete' abandons an unfinished task).
  return { decision: 'continue', normalized: clean.slice(0, 240) };
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
