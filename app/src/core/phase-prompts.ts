// Shared prompt builders + incoming-conversation shaping, used by BOTH the inline AgentLoop and
// the FASE 6 SubagentOrchestrator so the delegated phases and the inline phases stay prompt-
// identical (stub routers and live behavior match on the same wording).
//
// ADR A-008 (conversación base + append + solo el último mensaje). EVERY upstream phase call
// (interpret / planify / execute / evaluate, inline or delegated) uses exactly one shape:
//
//   [...clientMessages,                                          // verbatim: system intact,
//    ...(lastMessage ? [{ role: 'assistant', content: last }] : []),  // the ONLY intermediate
//    { role: 'user', content: <phase instruction> }]             // instruction appended last
//
// Rules:
//   1) The client's system message is preserved as-is; the proxy NEVER adds system messages and
//      never rewrites, reorders or drops client messages (the only exception: the rendered (flat)
//      fallback, when the upstream rejects the structured conversation shape — see below).
//   2) Every new instruction the proxy adds is a `user`-role message APPENDED at the end.
//   3) Intermediate messages generated/received through the API are NOT kept: only the LAST one
//      is retained for the whole process, carried as a single `assistant` turn.
//
// The rendered (flat) shapes are kept as the fallback for upstreams that reject structured
// assistant history (e.g. Vertex-backed models): on the first 4xx rejection the caller retries
// ONCE with the rendered version and then sticks to it for the rest of the run.

import type { UpstreamMessage } from '../types.js';
import type { ContextStep } from '../types.js';

/** Hint for the planify phase (the model's next best sub-goal). */
export function goalHintForPlanify(original: string, lastOutput: string): string {
  return `The goal is: "${original}". Previous attempt produced roughly: ${(lastOutput || '').slice(0, 240)}`;
}

/** Interpretation instruction (user role, appended at the end of the conversation). */
export const INTERPRET_INSTRUCTION = [
  'You are the interpreter of an agent loop proxy.',
  'Analyze the user request and reply with ONLY a JSON object (no prose).',
  'Object shape:',
  '{"mainObjective":"one sentence","subObjectives":["..."],"resourcesNeeded":["path or info to gather"]}',
  'If there are multiple aspects, subObjectives must have >= 1 item.',
  'If you cannot identify any sub-objective, say why in mainObjective and leave subObjectives empty.',
].join('\n');

/** Planify instruction (user role, appended at the end of the conversation). */
export function buildPlanifyInstruction(goalHint: string): string {
  return [
    'You are planning the next concrete, single action to move toward the goal.',
    '',
    `Goal hint:\n${goalHint}`,
    '',
    'Reply EXACTLY with one AgentTask JSON: {"description":"<one clear sentence>"}',
  ].join('\n');
}

/**
 * Evaluation instruction (user role, appended at the end of the conversation). The latest task
 * result arrives as the assistant message immediately BEFORE this instruction (ADR A-008) — the
 * evaluator judges that message against the original instruction.
 */
export function buildEvaluateInstruction(originalInstruction: string): string {
  return [
    'You are the evaluator of an agent loop. Reply with ONLY JSON.',
    `Original instruction: ${originalInstruction}`,
    '',
    'The assistant message immediately above is the latest result of the ongoing work.',
    'Reply with EXACTLY one of: {"complete": true} or {"complete": false}.',
  ].join('\n');
}

/**
 * ADR A-008 — the ONLY conversation shape for phase calls. The client base comes first untouched;
 * the last intermediate message (when any) rides as a single `assistant` turn; the phase
 * instruction is appended last as a `user` message. No system message is ever added.
 */
export function buildPhasePrompt(
  base: UpstreamMessage[],
  lastMessage: string | null,
  instruction: string,
): UpstreamMessage[] {
  const out: UpstreamMessage[] = base.map((m) => ({ ...m }));
  if (lastMessage) out.push({ role: 'assistant', content: lastMessage });
  out.push({ role: 'user', content: instruction });
  return out;
}

/** One-line-per-step history block (final-response metadata only — never sent upstream). */
export function stepBullets(steps: ContextStep[]): string {
  return steps.map((s) => `- iter ${s.iteration}: ${s.output.slice(0, 160)}`).join('\n');
}

/** Evaluator's accumulated-context block (final-response metadata only — never sent upstream). */
export function accumulatedSummary(steps: ContextStep[]): string {
  if (!steps.length) return '';
  return `Accumulated context:\n${stepBullets(steps)}`;
}

/**
 * Pass the incoming wire conversation through with roles PRESERVED — assistant turns (including
 * tool_call turns) and tool-result turns travel as they came. The client's system message is
 * untouched; the model's own history is its own history.
 */
export function toInternalMessages(messages: UpstreamMessage[]): UpstreamMessage[] {
  return messages.map((m) => ({ ...m }));
}

/**
 * Fallback shaping: assistant tool_call turns and tool-result turns are rendered as a single
 * plain-text `user` turn, for upstreams that reject structured assistant history (e.g. Gemini
 * thought_signatures / Vertex last-message-is-assistant rejections). The structured shape is
 * tried first and this rendering is the sticky 4xx fallback for the whole run.
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
