// The stream-event protocol (SC-009 / SC-010): the contract between the domain's `LoopSink`
// (what the agent loop / orchestrator emit) and the presentation's SSE writer (how those
// events are framed). Defined in the domain because the sink interface that consumes them
// (`LoopSink` in `agent-loop.ts`) is a domain contract; the SSE framing itself stays in the
// presentation layer.

/** Event names surfaced to clients (SC-009). */
export const SSE_EVENTS = {
  reasoning: 'reasoning',
  thinking: 'thinking',
  phaseUpdate: 'phase_update',
  taskResult: 'task_result',
  finalResult: 'final_result',
  contextClear: 'context_clear',
  toolCallRequest: 'tool_call_request',
} as const;

export type SSEEvent = (typeof SSE_EVENTS)[keyof typeof SSE_EVENTS];

/** Phases the stream reports (SC-010). */
export type Phase =
  | 'interpreting'
  | 'planning'
  | 'executing_task'
  | 'evaluating'
  | 'completed'
  | 'error';
