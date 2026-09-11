// Interpretation phase (FR-002 / SC-003, SC-004).
// Sends the original request to the model and asks for a structured interpretation:
// one main objective, sub-objectives for multi-aspect requests, and resources/context
// needed before executing. The structured reasoning is surfaced as a trace (SC-004).

import type { ChatProvider } from '../provider/types.js';
import type { NormalizedResult, UpstreamMessage, ToolCall } from '../types.js';

export interface Interpretation {
  mainObjective: string;
  subObjectives: string[];
  resourcesNeeded: string[];
}

/** Ask the model to interpret a request in a strict JSON shape. */
export async function interpretRequest(
  provider: ChatProvider,
  messages: UpstreamMessage[],
  buildPrompt: (messages: UpstreamMessage[]) => string,
  options?: { model: string | null; max_tokens?: number },
): Promise<{ interpretation: Interpretation; reasoning: string }> {
  const instruction = [
    'You are the interpreter of an agent loop proxy.',
    'Analyze the user request and reply with ONLY a JSON object (no prose).',
    'Object shape:',
    '{"mainObjective":"one sentence","subObjectives":["..."],"resourcesNeeded":["path or info to gather"]}',
    'If there are multiple aspects, subObjectives must have >= 1 item.',
    'If you cannot identify any sub-objective, say why in mainObjective and leave subObjectives empty.',
  ].join('\n');

  const promptMessages: UpstreamMessage[] = [
    { role: 'system', content: instruction },
    ...messages,
  ];

  const result: NormalizedResult = await provider.complete(
    options?.model ?? null, // concrete user-selected model — never "auto" (no-auto rule)
    promptMessages,
    { max_tokens: options?.max_tokens ?? 512 },
  );
  const text = (result.content ?? '').trim() || '{}';
  const parsed = safeJsonParse(text);
  if (!parsed) {
    // Fall back to treating the whole thing as the main objective.
    return { interpretation: { mainObjective: text, subObjectives: [], resourcesNeeded: [] }, reasoning: result.reasoning };
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
