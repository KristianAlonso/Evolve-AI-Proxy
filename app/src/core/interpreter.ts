// Interpretation phase (FR-002 / SC-003, SC-004).
// Sends the original request to the model and asks for a structured interpretation:
// one main objective, sub-objectives for multi-aspect requests, and resources/context
// needed before executing. The structured reasoning is surfaced as a trace (SC-004).

import type { ChatProvider } from '../provider/types.js';
import type { NormalizedResult, UpstreamMessage, ToolCall } from '../types.js';
import { callWithStreaming, type LiveEmitter } from './stream-helper.js';
import type { TraceLogger } from '../logger.js';

export interface Interpretation {
  mainObjective: string;
  subObjectives: string[];
  resourcesNeeded: string[];
}

/**
 * Ask the model to interpret a request in a strict JSON shape. ADR A-008: the caller builds the
 * FULL prompt (`buildPhasePrompt(base, lastMessage, INTERPRET_INSTRUCTION)`) — no system message
 * is added here, and the raw reply is returned (`raw`) so the caller can keep it as the process'
 * last intermediate message.
 */
export async function interpretRequest(
  provider: ChatProvider,
  messages: UpstreamMessage[],
  options?: { model: string | null; logger?: TraceLogger; traceId?: string; abort_signal?: AbortSignal; passthrough?: Record<string, unknown> },
  emitter?: LiveEmitter,
): Promise<{ interpretation: Interpretation; reasoning: string; raw: string; streamed: boolean }> {
  // Single shared call (FASE 1): stream live reasoning deltas when an emitter is attached, and
  // buffer otherwise. Structured `content` here is internal JSON that gets parsed into a trace below,
  // so only the thinking path surfaces on the wire — emitting it as assistant text would corrupt the
  // client's answer reconstruction. When no emitter is present the call stays fully buffered, which is
  // what every unit test exercises (they pass at most three args).
  const { result, streamed } = await callWithStreaming({
    provider,
    model: options?.model ?? null, // concrete user-selected model — never "auto" (no-auto rule)
    messages,
    // ADR A-007 (passthrough-intacto): no invented max_tokens budget — the client's request
    // parameters (temperature, max_tokens, ...) are forwarded exactly as sent; no client value means
    // no field in the upstream call.
    options: { passthrough: options?.passthrough, logger: options?.logger, trace_id: options?.traceId, abort_signal: options?.abort_signal },
    surfaceDelta: emitter ? (chunk) => {
      const reasoning = typeof chunk.reasoning === 'string' ? chunk.reasoning : '';
      if (reasoning !== '') emitter.emitReasoningDelta(0, reasoning);
    } : undefined,
  });
  const raw = (result.content ?? '').trim();
  const text = raw || '{}';
  const parsed = safeJsonParse(text);
  if (!parsed) {
    // Fall back to treating the whole thing as the main objective.
    return { interpretation: { mainObjective: text, subObjectives: [], resourcesNeeded: [] }, reasoning: result.reasoning, raw, streamed };
  }

  const mainObjective = String(parsed.mainObjective ?? text).slice(0, 500);
  const subObjectives = Array.isArray(parsed.subObjectives)
    ? parsed.subObjectives.map((s) => String(s)).filter(Boolean)
    : [];
  const resourcesNeeded = Array.isArray(parsed.resourcesNeeded)
    ? parsed.resourcesNeeded.map((r) => String(r)).filter(Boolean)
    : [];

  return {
    interpretation: { mainObjective, subObjectives, resourcesNeeded },
    reasoning: result.reasoning,
    raw,
    streamed,
  };
}

/** Build the structured trace body shown to the client for SC-004. */
export function formatInterpretationTrace(interp: Interpretation): string {
  const parts = [`mainObjective: ${interp.mainObjective}`];
  if (interp.subObjectives.length) {
    parts.push(`subObjectives:\n${interp.subObjectives.map((s) => `  - ${s}`).join('\n')}`);
  }
  if (interp.resourcesNeeded.length) {
    parts.push(`resourcesNeeded:\n${interp.resourcesNeeded.map((r) => `  - ${r}`).join('\n')}`);
  }
  return parts.join('\n');
}

/** Convert a native tool call list to a readable summary for traces. */
export function summarizeToolCalls(tool_calls: ToolCall[]): string {
  if (!tool_calls.length) return '';
  return tool_calls.map((tc) => `tool_call ${tc.function.name}(${tc.function.arguments ?? ''})`).join('; ');
}

function safeJsonParse(text: string): Record<string, unknown> | null {
  try {
    const cleaned = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}
