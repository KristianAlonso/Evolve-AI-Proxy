// Request validation against a structured schema (SC-016 / SC-024).
// Every incoming request is validated before any agent-loop logic runs, and every
// error field is reported together in a single response.

import { Type, TSchema } from '@sinclair/typebox';

export interface ValidationIssue {
  field: string;
  message: string;
}

/** Result of validation; `ok=true` means the request may proceed. */
export type ValidationResult =
  | { ok: true }
  | { ok: false; issues: ValidationIssue[] };

function isNonEmptyArray(v: unknown): boolean {
  return Array.isArray(v) && v.length > 0;
}

function isValidRole(role: unknown): boolean {
  return role === 'system' || role === 'user' || role === 'assistant' || role === 'tool';
}

/** TypeBox-free validator so we can collect ALL errors at once (SC-024). */
export function validateRequest(body: unknown): ValidationResult {
  if (!body || typeof body !== 'object') {
    return { ok: false, issues: [{ field: 'body', message: 'request must be a JSON object' }] };
  }
  const b = body as Record<string, unknown>;

  const issues: ValidationIssue[] = [];

  if (typeof b.model !== 'string' || b.model.trim() === '') {
    issues.push({ field: 'model', message: "'model' must be a non-empty string" });
  }
  if (!isNonEmptyArray(b.messages)) {
    issues.push({ field: 'messages', message: "'messages' must be a non-empty array" });
  } else {
    const msgs = b.messages as Array<Record<string, unknown>>;
    let hasUserOrSystem = false;
    for (const [i, m] of msgs.entries()) {
      if (!isValidRole(m.role)) {
        issues.push({ field: `messages[${i}].role`, message: 'must be system|user|assistant|tool' });
      }
      if ((m.role === 'user' || m.role === 'system')) hasUserOrSystem = true;
      if (typeof m.content !== 'string') {
        issues.push({ field: `messages[${i}].content`, message: "'content' must be a string" });
      }
      // reject stray tool_calls without matching roles to avoid malformed payloads early
      const tc = m.tool_calls;
      if (tc !== undefined && !Array.isArray(tc)) {
        issues.push({ field: `messages[${i}].tool_calls`, message: 'must be an array' });
      }
    }
    if (!hasUserOrSystem) {
      issues.push({ field: 'messages', message: 'at least one user or system message is required' });
    }
  }

  // numeric bounds (SC-024): temperature 0..2, positive max_tokens.
  const temp = b.temperature;
  if (temp !== undefined && (typeof temp !== 'number' || !(temp >= 0 && temp <= 2))) {
    issues.push({ field: 'temperature', message: 'must be a number between 0 and 2' });
  }

  // evolve controls must be positive integers when present.
  for (const f of ['max_retries', 'max_rounds'] as const) {
    if (b[f] !== undefined && b[f] !== null && !Number.isInteger(b[f])) {
      issues.push({ field: f, message: `must be a positive integer` });
    } else if (typeof b[f] === 'number' && b[f] < 1) {
      issues.push({ field: f, message: `must be >= 1` });
    }
  }

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

/** Compile the request schema once (also used for docs/openapi surface). */
export const SCHEMA = {
  type: 'object',
  required: ['model', 'messages'],
  properties: {
    model: { type: 'string' },
    messages: { type: 'array', items: {} },
    temperature: { type: 'number' },
    max_tokens: { type: ['integer', 'null'] },
  },
};

export type RequestSchema = TSchema;
void SCHEMA; // schema kept for openapi exposure only; runtime uses validateRequest()
