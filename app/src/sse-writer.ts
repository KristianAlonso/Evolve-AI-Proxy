// Server-Sent Events writer (SC-009 / SC-010 / SC-023).
// Emits typed SSE events, wraps reasoning between __REASONING_START__/__REASONING_END__,
// and surfaces client-disconnect so the orchestrator can abort immediately.

import type { FastifyReply } from 'fastify';
import { createLogger, type TraceLogger } from './logger.js';
import type { ToolCall } from './types.js';

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

const REASONING_START = '__REASONING_START__';
const REASONING_END = '__REASONING_END__';
let idCounter = 0;

/**
 * Streaming sink for a single request. Callers write typed events through `writeEvent`;
 * the writer converts them into SSE frames and throws on disconnect (SC-023).
 */
export class SseWriter {
  private connected = true;
  private readonly reply: FastifyReply;
  private readonly logger: TraceLogger;
  /** Count of chat-completion.chunk frames emitted (logged at stream end for traceability). */
  frames = 0;

  constructor(reply: FastifyReply, logger?: TraceLogger) {
    this.reply = reply;
    this.logger = logger ?? createLogger('sse');
    // Ensure the response is a proper SSE stream with correct headers.
    reply.type('text/event-stream');
    reply.header('Cache-Control', 'no-cache, no-transform');
    reply.header('Connection', 'keep-alive');
    // Fastify already flushes each `send` for streaming responses, so clients receive
    // events in real time without an explicit flush() call.

    // SC-023: if the client drops mid-flight we can no longer write; mark disconnected
    // so any pending SSE event surfaces and callers abort immediately.
    this.reply.raw.on('close', () => {
      this.connected = false;
    });

    this.safeWrite(': connected\n\n');
  }

  private get id(): string {
    return `evolve-${Date.now().toString(36)}-${(idCounter += 1)}`;
  }

  /** True once the client has dropped the connection (so callers can abort). */
  get isDisconnected(): boolean {
    return !this.connected;
  }

  // SSE frames are written directly to the underlying socket. Fastify treats a second
  // `reply.send()` as response-terminating, which would drop every per-phase/thinking frame
  // after the first byte — so we bypass it and push bytes straight on `reply.raw`. Each call is
  // a discrete SSE frame delivered to the client in order (per-frame incremental deltas).
  private safeWrite(text: string): void {
    if (!this.connected) throw new Error('client disconnect');
    try {
      this.reply.raw.write(text);
    } catch (err) {
      // Client closed the connection or an error occurred mid-stream.
      this.connected = false;
      throw err ?? new Error('client disconnect');
    }
  }

  /** Emit a typed event as one SSE frame (SC-009). */
  writeEvent(event: SSEEvent, data: Record<string, unknown>): void {
    const id = this.id;
    const payload = `event: ${event}\nid: ${id}\ndata: ${JSON.stringify(data)}\n\n`;
    // Best-effort once a disconnect is already known elsewhere; but the moment we learn the client
    // dropped, this throws (FR-015 / SC-023) so callers abort immediately rather than swallow events.
    this.safeWrite(payload);
  }

  /** Emit raw reasoning text wrapped between markers (SC-005). */
  emitReasoning(iteration: number, text: string): void {
    const body = [REASONING_START, text, REASONING_END].filter(Boolean).join('\n');
    this.writeEvent(SSE_EVENTS.reasoning, { iteration, content: body });
  }

  /** Emit a live reasoning delta — the incremental thinking produced during a stream. */
  emitReasoningDelta(iteration: number, delta: string): void {
    if (delta === '') return;
    this.writeEvent(SSE_EVENTS.thinking, { iteration, delta });
  }

  /** Emit a phase transition with optional per-task index (SC-010). */
  emitPhase(phase: Phase, extra?: Record<string, unknown>): void {
    const data = { phase, ...extra };
    this.writeEvent(SSE_EVENTS.phaseUpdate, data);
  }

  /** Signal that all prior reasoning traces should be discarded (SC-011). */
  emitContextClear(iteration: number): void {
    this.writeEvent(SSE_EVENTS.contextClear, { iteration });
  }

  /** Signal a tool-call request and cede control to the client (SC-015). */
  emitToolCallRequest(
    id: string,
    name: string,
    description: string,
    args: Record<string, unknown>,
  ): void {
    this.writeEvent(SSE_EVENTS.toolCallRequest, {
      tool_call_id: id,
      name,
      description,
      arguments_json: JSON.stringify(args),
    });
  }

/** Emit a single OpenAI-compatible chat.completion.chunk frame (SC-018 + AISDK compat). */
  /** True once the first assistant content delta has been flushed — subsequent text deltas carry no role. */
  private assistantTextStarted = false;

  /**
   * A single OpenAI-compatible `chat.completion.chunk` frame (SC-018 + AISDK/opencode compat).
   * The client validates every data block as this shape and aborts on the first one lacking
   * a `choices` array, so the choice delta plus an optional terminal `finishReason` is exactly
   * what must be produced — no proprietary frame may ever reach the wire here.
   */
  public emitAiChunk(
    choice: { index: number; delta: Record<string, unknown>; finishReason?: string },
    /** Optional REAL token usage for the finish frame — the client (opencode) tracks context
     *  occupancy from it and triggers its own compaction. */
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
  ): void {
    this.frames++;
    const payload = JSON.stringify({
      id: this.id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'evolve_proxy_default',
      choices: [
        choice.finishReason !== undefined
          ? { index: choice.index, delta: choice.delta, finish_reason: choice.finishReason }
          : { index: choice.index, delta: choice.delta },
      ],
      ...(usage ? { usage } : {}),
    });
    // No `event:` line — only a bare `data:` block. OpenAI-compatible clients (opencode, the Vercel
    // AI SDK) validate every data frame as a chat-completion chunk and reject any that lacks
    // `choices`; this is exactly their shape (index/delta + finish_reason), so they accept it.
    this.safeWrite(`data: ${payload}\n\n`);
  }

  /** OpenAI-compatible reasoning delta — live thinking, no role needed in the delta. */
  public emitAiReasoningDelta(iteration: number, text: string): void {
    if (text === '') return;
    this.emitAiChunk({ index: 0, delta: { reasoning: text }, finishReason: undefined });
  }

  /** OpenAI-compatible assistant content delta — role only on the very first text chunk. */
  public emitAiContent(_iteration: number, text: string): void {
    if (text === '') return;
    const hasRole = !this.assistantTextStarted;
    this.assistantTextStarted = true;
    this.emitAiChunk({ index: 0, delta: hasRole ? { role: 'assistant', content: text } : { content: text }, finishReason: undefined });
  }

  /**
   * Emit delegated tool calls as standard OpenAI streaming chunks (FASE 2): one chunk per tool
   * call, each carrying the complete `delta.tool_calls` entry (id + function name + full
   * arguments). Complete — not incremental — entries keep the frames trivially parseable by any
   * OpenAI-compatible client (opencode / Vercel AI SDK), which finalizes a tool call from them.
   * The caller follows up with `emitAiFinish('tool_calls')` + [DONE].
   */
  public emitAiToolCalls(calls: ToolCall[]): void {
    calls.forEach((call, index) => {
      const delta: Record<string, unknown> = {
        tool_calls: [
          {
            index,
            id: call.id,
            type: 'function',
            function: { name: call.function.name, arguments: call.function.arguments },
          },
        ],
      };
      if (index === 0) delta.role = 'assistant';
      this.emitAiChunk({ index: 0, delta, finishReason: undefined });
    });
  }

  /** OpenAI-compatible finish chunk: empty delta, `finish_reason` set (SC-018).
   *  Accepts the real upstream usage so the client can track tokens per message. */
  public emitAiFinish(finishReason: string, usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }): void {
    this.emitAiChunk({ index: 0, delta: {}, finishReason }, usage);
  }

  /** Notify that the client disconnected mid-flight so callers can abort (SC-023). */
  markDisconnected(): void {
    this.connected = false;
  }

  /** True once at least one assistant content delta has been flushed to the wire. */
  public hasEmittedContent(): boolean {
    return this.assistantTextStarted;
  }
}
