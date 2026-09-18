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

import type { UpstreamMessage } from './types.js';
import type { ContextStep } from './types.js';

/** Hint for the planify phase (the model's next best sub-goal). */
export function goalHintForPlanify(original: string, lastOutput: string): string {
  return `The goal is: "${original}". Previous attempt produced roughly: ${(lastOutput || '').slice(0, 240)}`;
}

/**
 * Tool-call veto for the tool-less phase calls (interpret / planify / evaluate). The phase prompt
 * carries the PARENT'S conversation — which includes the client-executed `task` spawns (assistant
 * tool_calls + tool results) — and the phase call itself carries NO tools. A local model can
 * pattern-complete that sequence and "emit" a tool call in plain text (e.g. a fake
 * `<function=task>` block ending the subagent with garbage instead of the requested JSON).
 * The veto makes the expectation explicit: history tool calls already happened; reply with JSON.
 */
const NO_TOOL_CALLS_DIRECTIVE =
  'NEVER emit, imitate or reference tool calls: every tool call visible in the conversation '
  + 'history was ALREADY executed by the client. Your reply is the JSON object and nothing else.';

/** Interpretation instruction (user role, appended at the end of the conversation). */
export const INTERPRET_INSTRUCTION = [
  'You are the interpreter of an agent loop proxy.',
  'Analyze the user request and reply with ONLY a JSON object (no prose).',
  'Object shape:',
  '{"mainObjective":"one sentence","subObjectives":["..."],"resourcesNeeded":["path or info to gather"]}',
  'If there are multiple aspects, subObjectives must have >= 1 item.',
  'If you cannot identify any sub-objective, say why in mainObjective and leave subObjectives empty.',
  NO_TOOL_CALLS_DIRECTIVE,
].join('\n');

/** Planify instruction (user role, appended at the end of the conversation). */
export function buildPlanifyInstruction(goalHint: string, steering?: string): string {
  return [
    'You are planning the next concrete, single action to move toward the goal.',
    '',
    `Goal hint:\n${goalHint}`,
    steering ? '' : null,
    steering ? `NEW USER DIRECTION (typed while the loop was running — it MUST be incorporated into the plan, overriding the previous approach where they conflict):\n${steering}` : null,
    '',
    'Reply EXACTLY with one AgentTask JSON: {"description":"<one clear sentence>"}',
    NO_TOOL_CALLS_DIRECTIVE,
  ].filter((l): l is string => l !== null).join('\n');
}

/**
 * Evaluation instruction (user role, appended at the end of the conversation). The latest task
 * result arrives as the assistant message immediately BEFORE this instruction (ADR A-008) — the
 * evaluator judges that message against the original instruction.
 */
export function buildEvaluateInstruction(originalInstruction: string, steering?: string): string {
  return [
    'You are the evaluator of an agent loop. Reply with ONLY JSON.',
    `Original instruction: ${originalInstruction}`,
    steering ? `\nUpdated user direction (also applies to the goal): ${steering}` : null,
    '',
    'The assistant message immediately above is the latest result of the ongoing work.',
    'Reply with EXACTLY one of:',
    '  {"complete": true} — the goal is fully met.',
    '  {"complete": false} — not met, and the agent can keep working on it by itself.',
    '  {"complete": false, "awaiting_user": true} — not met AND the work is BLOCKED on something only the',
    '    user can provide: the latest result is a question, a request for a decision/choice, credentials,',
    '    or any other input directed at a human. (Do NOT restate the question in the JSON — it is',
    '    already in the latest result; just flag it.)',
    'Do not invent a question the latest result does not contain.',
    NO_TOOL_CALLS_DIRECTIVE,
  ].filter((l): l is string => l !== null).join('\n');
}

/**
 * User-intervention marker (contract, see buildExecuteInstruction / the spawn prompts): when a
 * phase output is a question/request directed at the USER, the model replies with EXACTLY one
 * line starting with `ASK_USER:` followed by the question. The orchestrator detects the marker
 * deterministically (extractAskUser) and stops the loop IMMEDIATELY — no evaluate round-trip.
 */
export const ASK_USER_MARKER = 'ASK_USER:';

/**
 * The one-line contract text appended to the phase instructions: if the phase CANNOT proceed
 * without user input, the model must signal it with the ASK_USER marker instead of guessing.
 */
export const ASK_USER_CONTRACT =
  `IF the task CANNOT be completed without input from the USER (a decision, a choice, credentials, ` +
  `a missing requirement), STOP and reply with EXACTLY one line: ${ASK_USER_MARKER} <your question or ` +
  `request, in the user's language> — and nothing else. Never guess, never make up an answer yourself.`;

// Batch variant (used when the client exposes a question tool that accepts several questions at
// once): the model emits the marker followed by a JSON ARRAY of question objects, so the
// orchestrator can pose ALL pending questions to the user in a single form.
export const ASK_USER_CONTRACT_BATCH =
  `IF you CANNOT proceed without input from the USER (a decision, a choice, a missing detail), STOP ` +
  `and reply with EXACTLY the line ${ASK_USER_MARKER} followed by a JSON ARRAY of question objects — ` +
  `nothing else, no markdown fences, no prose. Each object: ` +
  `{"question":"<the question text>","header":"<short label>","options":[{"label":"<option text>","description":"<why this option>"}],"multiple":false}` +
  ` You may include ALL your questions in that array — they will all be shown to the user at once.`;

/**
 * Deterministic user-intervention detection: when the (trimmed) phase output starts with the
 * ASK_USER marker, return the question (marker stripped, trimmed); otherwise null. This is how
 * the orchestrator stops the loop the moment a phase output IS a question for the user — without
 * waiting for the evaluate phase (which would cost a whole extra subagent spawn).
 */
export function extractAskUser(output: string): string | null {
  const t = output.trim();
  if (!t.startsWith(ASK_USER_MARKER)) return null;
  const q = t.slice(ASK_USER_MARKER.length).trim();
  return q.length > 0 ? q : null;
}

/**
 * Execute instruction (user role, appended at the end of the conversation).
 *
 * The raw task description is NOT sent bare: sent as the final user turn while the SAME text
 * already rides in the previous planify tool result, a local model parrots it verbatim ("what I
 * was going to do") and the round ends with no work performed (observed live: execute R1 echoed
 * the plan description, the evaluator — correctly — marked it incomplete). The imperative frame
 * breaks the parroting: execute now, with tool calls, and do not re-plan.
 */
export function buildExecuteInstruction(
  description: string,
  toolsAvailable: boolean,
  questionMode: 'batch' | 'single' = 'single',
): string {
  const lines: string[] = [
    'You are the executor of an agent loop. EXECUTE the following task NOW — do not re-plan, '
      + 'do not repeat or summarize the plan, do not propose what to do.',
  ];
  if (toolsAvailable) {
    lines.push(
      'Carry it out with tool calls: the client executes them and returns the results. '
        + 'Reply with plain text only when the task is actually done.',
    );
  }
  lines.push('', `Task: ${description}`, 'When done, report what was actually done and its concrete outcome.', questionMode === 'batch' ? ASK_USER_CONTRACT_BATCH : ASK_USER_CONTRACT);
  return lines.join('\n');
}

/**
 * Detects a phase output that IMITATED a tool call in plain text instead of replying with the
 * requested JSON — the model pattern-completes the parent's `task` tool calls visible in the
 * context while the phase call carries no tools (XML-style `<function=...>` blocks or
 * Anthropic-style `antml:` blocks).
 */
export function isToolCallEcho(content: string): boolean {
  return /<function=|antml:invoke|antml:parameter/i.test(content);
}

/** Rough token estimate for a prompt (~4 chars per token, same heuristic as the capture interceptor). */
export function estimatePromptTokens(messages: UpstreamMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content ?? '').length;
    if (m.tool_calls && m.tool_calls.length > 0) chars += JSON.stringify(m.tool_calls).length;
  }
  return Math.ceil(chars / 4);
}

/**
 * Context-compaction threshold (client-delegated compaction). The proxy NEVER truncates, cuts or
 * condenses messages: when the REAL upstream usage of a call shows the context at or beyond
 * `threshold` (fraction, e.g. 0.9) of the known window, the loop is interrupted and the compaction
 * is delegated to the client — the client compacts its own conversation (its request is passed
 * through as-is) and resumes, and the proxy adopts the new (compacted) context, discarding the
 * old messages entirely. `windowSize <= 0` (unknown window) disables the check (SC-022):
 * the upstream decides and any `ContextWindowExceeded` is still fail-fast (no retries).
 */
export function contextFull(
  usage: { prompt_tokens?: number } | null | undefined,
  windowSize: number,
  threshold: number,
): boolean {
  if (!(windowSize > 0) || !usage) return false;
  return (usage.prompt_tokens ?? 0) >= windowSize * threshold;
}

/**
 * Notice returned (instead of a real phase result) while the loop waits for the client's
 * compaction: the phase is paused, no upstream call is made, and no phase result is stored —
 * the pending spawn is re-emitted (stable agent_id) until the compacted context arrives.
 */
export const COMPACT_PENDING_NOTICE =
  'Agent loop paused: the conversation context has reached the compaction threshold. The client will ' +
  'compact its conversation history; when it resumes, the pending phase will continue with the ' +
  'compacted context. No further work is produced in this session.';

/**
 * Detects a client-initiated context-compaction request (e.g. OpenCode's pre-compaction summary
 * call): a single user message whose content embeds the conversation to be summarized. The proxy
 * passes these requests through to the upstream untouched — no agent loop, no orchestrator, no
 * phase bookkeeping — and the response (the summary) goes back to the client as-is.
 */
export function isCompactionRequest(messages: UpstreamMessage[]): boolean {
  // Only the most recent user message can be a compaction request (the conversation rides verbatim
  // inside it).
  let lastUser: string | null = null;
  for (const m of messages) {
    if (m.role === 'user') lastUser = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
  }
  if (lastUser === null) return false;
  // OpenCode: "Here is the conversation so far:" + "Create a new anchored summary ...". The
  // Stainless SDK helper (Anthropic path) says "Write a continuation summary ...". Match both.
  return /here is the conversation so far/i.test(lastUser) || /continuation summary|anchored summary/i.test(lastUser);
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
 *
 * Transport failures (connection refused/reset, timeouts, socket errors) are NEVER a structured
 * rejection — nothing is listening to render-fallback to. They are matched explicitly and
 * excluded first; the status codes are word-bounded so a port number (e.g. the upstream on
 * `:4000`) can't masquerade as an HTTP 400 in the message text.
 */
export function isStructuredRejection(err: unknown): boolean {
  const text = String(err);
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|fetch failed/i.test(text)) return false;
  return /\b(400|422)\b|invalid|malformed|schema|unexpected|role|thought_signature|context/i.test(text);
}
