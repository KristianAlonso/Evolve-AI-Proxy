// FASE 6 — question-tool support: the client's interactive question tool (e.g. OpenCode's
// `question`), detected + mapped by the model (mimicking the subagent-spawn mapping), and used
// to escalate the agent-loop's questions to the USER. When the tool exists in the parent
// conversation, the orchestrator emits a `question` tool call carrying ONE OR MORE questions
// (batch) — the client shows a form and the user's answer comes back as a `tool` result. When
// no question tool exists, the proxy falls back to the single-question `ASK_USER:` marker
// (awaiting_user final, the user replies in chat).
//
// This module is PURE: no provider, no fastify, no fs — only the model-mapped spec, the
// ToolCall builder, the parser, and the (pure) answer lookup in an incoming message pile.

import type { ToolCall, ToolDefinition, UpstreamMessage } from './types.js';

/** A single question option the user can pick. */
export interface QuestionOption {
  label: string;
  description?: string;
}

/** One question to pose to the user (batch = several of these at once). */
export interface QuestionItem {
  question: string;
  header?: string;
  options?: QuestionOption[];
  multiple?: boolean;
}

/**
 * The mapped shape of the client's question tool, produced by the model (question-mapper).
 * - `toolName`: the client tool that asks the user (must exist in the parent conversation).
 * - `questionsArg`: the argument name that carries the questions (e.g. "questions").
 * - `batch`: true when that argument accepts an ARRAY of questions (several at once).
 */
export interface QuestionToolSpec {
  toolName: string;
  questionsArg: string;
  batch: boolean;
}

/**
 * Build the ToolCall the proxy emits (parent side) to ask the user its question(s) through the
 * client's question tool. For a batch tool the full array goes in `questionsArg`; for a
 * single-question tool only the first question is sent.
 */
export function buildQuestionToolCall(spec: QuestionToolSpec, id: string, questions: QuestionItem[]): ToolCall {
  const items = spec.batch ? questions : questions.slice(0, 1);
  const payload: Record<string, unknown> = { [spec.questionsArg]: items };
  return {
    id,
    type: 'function',
    function: {
      name: spec.toolName,
      arguments: JSON.stringify(payload),
    },
  };
}

/**
 * Parse the model's question-tool mapping answer into a QuestionToolSpec. Returns null when
 * the answer is not valid JSON, marks `{"none":true}`, names a tool the client doesn't offer,
 * or has no usable questions argument. `clientToolNames` = the client's tool names.
 */
export function parseQuestionSpec(raw: string, clientToolNames: readonly string[]): QuestionToolSpec | null {
  let parsed: unknown;
  try {
    const cleaned = raw.replace(/```(?:json)?/gi, '').trim();
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const rec = parsed as Record<string, unknown>;
  if (rec.none === true) return null;
  const toolName = typeof rec.tool_name === 'string' && rec.tool_name ? rec.tool_name : null;
  if (!toolName || !clientToolNames.includes(toolName)) return null;
  const qa = typeof rec.questions_arg === 'string' && rec.questions_arg ? rec.questions_arg : null;
  if (!qa) return null;
  return { toolName, questionsArg: qa, batch: rec.batch === true };
}

/**
 * Parse a phase result's `ASK_USER:` payload (the text AFTER the marker) into a batch of
 * QuestionItems. Returns null when the payload is plain text (single-question mode — see
 * `extractAskUser`) or not a parseable JSON array/object of questions.
 */
export function parseAskUserQuestions(raw: string): QuestionItem[] | null {
  const t = raw.trim();
  if (!t.startsWith('[') && !t.startsWith('{')) return null; // plain text → single-question mode
  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch {
    return null;
  }
  let arr: unknown[] | null = null;
  if (Array.isArray(parsed)) {
    arr = parsed;
  } else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { questions?: unknown[] }).questions)) {
    arr = (parsed as { questions: unknown[] }).questions;
  }
  if (!arr || arr.length === 0) return null;

  const items: QuestionItem[] = [];
  for (const q of arr) {
    if (q && typeof q === 'object' && typeof (q as { question?: unknown }).question === 'string') {
      const obj = q as { question: string; header?: unknown; options?: unknown; multiple?: unknown };
      items.push({
        question: obj.question,
        header: typeof obj.header === 'string' ? obj.header : undefined,
        options: Array.isArray(obj.options)
          ? obj.options
              .filter((o) => !!o && typeof o === 'object' && typeof (o as { label?: unknown }).label === 'string')
              .map((o) => {
                const oo = o as { label: string; description?: unknown };
                return { label: oo.label, description: typeof oo.description === 'string' ? oo.description : undefined };
              })
          : undefined,
        multiple: typeof obj.multiple === 'boolean' ? obj.multiple : undefined,
      });
    }
  }
  return items.length > 0 ? items : null;
}

/**
 * Find the answer to a question tool call (emitted by the proxy, answered by the client/user)
 * in the parent's incoming message pile. Strict: a `tool` message whose `tool_call_id` is the
 * question id. Loose fallback: the last `tool` message after the last `assistant` turn carrying
 * that question tool call (clients that re-mint tool ids). Returns the answer text, or null.
 */
export function findQuestionAnswer(
  questionId: string,
  messages: readonly UpstreamMessage[] | null | undefined,
): string | null {
  if (!messages || messages.length === 0) return null;
  // Strict match on the (stable) question tool call id.
  for (const m of messages) {
    if (m.role === 'tool' && m.tool_call_id === questionId) return m.content ?? '';
  }
  // Loose: last `tool` message after the last `assistant` turn that carries the question call
  // (handles clients that re-mint the tool_call_id).
  let questionTurn = -1;
  messages.forEach((m, i) => {
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) {
        if (tc.id === questionId) questionTurn = i;
      }
    }
  });
  if (questionTurn >= 0) {
    for (let i = messages.length - 1; i > questionTurn; i--) {
      if (messages[i].role === 'tool') return messages[i].content ?? '';
    }
  }
  return null;
}

/** The client tools' names (for spec validation). */
export function clientToolNames(tools: readonly ToolDefinition[]): string[] {
  return tools.map((t) => t.function.name);
}
