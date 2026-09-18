// Pure OpenAI wire serializers (SC-018): the completion JSON objects, the finish_reason
// mapping, and the standard error payload. No Fastify, no I/O — the presentation layer ships
// whatever this returns.

import type { FinalResultData } from '../domain/agent-loop.js';
import type { OrchestratorOutcome } from '../domain/orchestrator.js';
import { accumulatedSummary } from '../domain/phase-prompts.js';
import type { LoopStateData } from '../domain/loop-state.js';
import type { LoopDecision, TokenUsage, ToolCall } from '../domain/types.js';

/** Map the orchestrator decision to an OpenAI finish_reason and refused flag (SC-018). */
export function finishReason(decision: LoopDecision): { reason: string; refused: boolean } {
  switch (decision) {
    case 'complete':
      return { reason: 'stop', refused: false };
    case 'max_rounds_exceeded':
      return { reason: 'length', refused: false };
    case 'refusal_exhausted':
      return { reason: 'stop', refused: true };
    // FASE 2: the client executes the delegated tools and resumes the conversation.
    case 'tool_calls_pending':
      return { reason: 'tool_calls', refused: false };
    // Context full: the loop was interrupted so the CLIENT compacts its own context. The
    // response is a normal assistant turn (a short pause notice), then the client resumes.
    case 'context_compact_pending':
      return { reason: 'stop', refused: false };
    // The evaluator said the loop is blocked on user input: the reply IS the question (an
    // ordinary assistant turn); the loop pauses with its state preserved for the user's answer.
    case 'awaiting_user':
      return { reason: 'stop', refused: false };
    default:
      return { reason: 'error', refused: true };
  }
}

/** OpenAI-compatible chat.completion object (SC-018) from a finished loop result. */
export function toOpenAICompletion(
  model: string,
  finalResult: FinalResultData,
  traceId: string,
): Record<string, unknown> {
  const { reason, refused } = finishReason(finalResult.decision);
  return {
    id: `chatcmpl-${Date.now().toString(36)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: finalResult.decision === 'tool_calls_pending' ? null : finalResult.final_output || '',
          tool_calls: finalResult.tool_calls,
        },
        finish_reason: reason,
      },
    ],
    // REAL upstream usage of the loop's last call (the client tracks context occupancy from it
    // and triggers its own compaction at its threshold) — zeros only when no call ever ran.
    usage: finalResult.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    meta: {
      agent_decision: finalResult.decision,
      iterations_completed: finalResult.iterations_completed,
      max_rounds: finalResult.max_rounds,
      upstream_calls: finalResult.reasoning_traces_summary.total_upstream_calls,
      refused,
      trace_id: traceId,
    },
  };
}

/** Build a plain assistant completion (stream=false / compaction) from raw upstream output. */
export function textCompletion(params: {
  model: string;
  content: string;
  usage?: TokenUsage;
  meta?: Record<string, unknown>;
  /** Present when the model invoked the client's tools (subagent phase with delegated tools): the
   *  completion carries the tool_calls and finish_reason 'tool_calls'. */
  toolCalls?: ToolCall[];
  finishReason?: string;
}): Record<string, unknown> {
  const { model, content, usage, meta, toolCalls = [], finishReason } = params;
  return {
    id: `chatcmpl-${Date.now().toString(36)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: toolCalls.length > 0 ? null : content,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
    }],
    usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    meta,
  };
}

/** Standard error payload for a failed upstream call (502 bodies, in-band stream errors). */
export function upstreamErrorPayload(detail: string, traceId: string): {
  error: { message: string; type: 'upstream_error'; detail: string; trace_id: string };
} {
  return {
    error: { message: 'upstream unavailable', type: 'upstream_error', detail, trace_id: traceId },
  };
}

/** FASE 6: fold an orchestrator outcome into the FinalResultData the OpenAI completion uses. */
export function toFinalResult(state: LoopStateData, outcome: OrchestratorOutcome): FinalResultData {
  return {
    final_output: outcome.finalOutput,
    iterations_completed: state.accumulatedSteps.length,
    decision: outcome.decision,
    max_rounds: state.max_rounds,
    tasks_executed: state.accumulatedSteps.map((s) => ({
      id: s.task_id ?? `iter-${s.iteration}`,
      status: 'completed' as const,
      output: s.output,
    })),
    reasoning_traces_summary: {
      phases_completed: [],
      total_upstream_calls: state.totalUpstreamCalls,
      errors_occurred: 0,
    },
    accumulated_context: accumulatedSummary(state.accumulatedSteps),
    tool_calls: outcome.kind === 'tool_call' && outcome.toolCall ? [outcome.toolCall] : [],
  };
}
