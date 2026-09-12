// Shared prompt builders + incoming-conversation shaping, used by BOTH the inline AgentLoop and
// the FASE 6 SubagentOrchestrator so the delegated phases and the inline phases stay prompt-
// identical (stub routers and live behavior match on the same wording).
//
// R1 (FASE 6): assistant messages travel to the model as REAL assistant turns — never flattened
// into system/user. The rendered (flat) shapes are kept as the fallback for upstreams that reject
// structured assistant history (e.g. Vertex-backed models): on the first 4xx rejection the caller
// retries ONCE with the rendered version and then sticks to it for the rest of the run.

import type { UpstreamMessage } from '../types.js';
import type { ContextStep } from './context-manager.js';

/** Hint for the planify phase (the model's next best sub-goal). */
export function goalHintForPlanify(original: string, lastOutput: string): string {
  return `The goal is: "${original}". Previous attempt produced roughly: ${(lastOutput || '').slice(0, 240)}`;
}

/** Planify prompt (wording shared with the inline loop's planify). */
export function buildPlanifyPrompt(goalHint: string): UpstreamMessage[] {
  return [
    { role: 'system', content: 'You are planning the next concrete, single action to move toward the goal.' },
    { role: 'user', content: `Goal hint:\n${goalHint}\n\nReply EXACTLY with one AgentTask JSON: {"description":"<one clear sentence>"}` },
  ];
}

/** One-line-per-step history block. */
export function stepBullets(steps: ContextStep[]): string {
  return steps.map((s) => `- iter ${s.iteration}: ${s.output.slice(0, 160)}`).join('\n');
}

/**
 * Execute prompt, STRUCTURED (R1): previous phase outputs travel as genuine `assistant` turns and
 * the prompt always ends on a `user` turn (the current task) — it never ends on assistant history.
 */
export function buildStructuredExecutePrompt(original: string, steps: ContextStep[], taskDescription: string): UpstreamMessage[] {
  const prompt: UpstreamMessage[] = [{ role: 'system', content: `Goal: ${original}` }];
  for (const step of steps) prompt.push({ role: 'assistant', content: step.output });
  prompt.push({
    role: 'user',
    content: `Progress so far:\n${stepBullets(steps) || '(none)'}\n\nNext task:\n${taskDescription}`,
  });
  return prompt;
}

/**
 * Execute prompt, RENDERED (legacy fallback shape): the whole history folded into one `user`
 * turn before the task. Used when the upstream rejects the structured assistant history (R1
 * fallback) — a 4xx-shaped rejection means "your conversation shape is wrong", not "my request is
 * wrong".
 */
export function buildRenderedExecutePrompt(original: string, steps: ContextStep[], taskDescription: string): UpstreamMessage[] {
  return [
    { role: 'system', content: `Goal: ${original}` },
    { role: 'user', content: `Progress so far:\n${stepBullets(steps) || '(none)'}` },
    { role: 'user', content: taskDescription },
  ];
}

/** Evaluator's accumulated-context block (identical to the inline loop's summary). */
export function accumulatedSummary(steps: ContextStep[]): string {
  if (!steps.length) return '';
  return `Accumulated context:\n${stepBullets(steps)}`;
}

/**
 * R1: pass the incoming wire conversation through with roles PRESERVED — assistant turns (including
 * tool_call turns) and tool-result turns travel as they came. The model's own history is its own
 * history; flattening it destroyed conversational semantics.
 */
export function toInternalMessages(messages: UpstreamMessage[]): UpstreamMessage[] {
  return messages.map((m) => ({ ...m }));
}

/**
 * R1 fallback shaping (the pre-FASE-6 behavior): assistant tool_call turns and tool-result turns
 * are rendered as a single plain-text `user` turn, for upstreams that reject structured assistant
 * history (e.g. Gemini thought_signatures / Vertex last-message-is-assistant rejections).
 */
export function toRenderedMessages(messages: UpstreamMessage[]): UpstreamMessage[] {
  const out: UpstreamMessage[] = [];
  let exchange: string[] = [];
  const flushExchange = (): void => {
    if (exchange.length > 0) {
      out.push({ role: 'user', content: `Tool exchange (already performed by the client):\n${exchange.join('\n')}` });
      exchange = [];
    }
  };
  for (const message of messages) {
    if (message.role === 'tool') {
      exchange.push(`tool result for ${message.tool_call_id ?? ''}: ${message.content ?? ''}`);
      continue;
    }
    if (message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0) {
      for (const call of message.tool_calls) {
        exchange.push(`assistant tool_call ${call.id}: ${call.function.name}(${call.function.arguments})`);
      }
      if (message.content) exchange.push(`assistant: ${message.content}`);
      continue;
    }
    flushExchange();
    out.push(message);
  }
  flushExchange();
  return out;
}

/**
 * Heuristic: did the upstream reject the STRUCTURED conversation shape (so the rendered fallback
 * is worth trying) rather than a real content/policy failure? Deliberately broad but anchored on
 * 4xx + shape/role vocabulary; aborts never match (callers exclude them explicitly).
 */
export function isStructuredRejection(err: unknown): boolean {
  const text = String(err);
  return /400|422|invalid|malformed|schema|unexpected|role|thought_signature|context/i.test(text);
}
