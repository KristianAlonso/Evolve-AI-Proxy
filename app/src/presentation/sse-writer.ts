// Server-Sent Events writer (SC-009 / SC-010 / SC-023).
// Emits typed SSE events, wraps reasoning between __REASONING_START__/__REASONING_END__,
// and surfaces client-disconnect so the orchestrator can abort immediately.

import type { FastifyReply } from 'fastify';
import { createLogger, type TraceLogger } from '../infrastructure/logger.js';
import type { ToolCall } from '../domain/types.js';
import { SSE_EVENTS } from '../domain/agent-events.js';
import type { SSEEvent, Phase } from '../domain/agent-events.js';

// Re-exported for existing import sites (tests, adapters) — the contract itself lives in the
// domain (`domain/agent-events.ts`).
export { SSE_EVENTS };
export type { SSEEvent, Phase };

const REASONING_START = '__REASONING_START__';
const REASONING_END = '__REASONING_END__';
/**
 * Idle window for the keep-alive: while the upstream is silent (long prefills on slow
 * llama.cpp hosts — the delegated execute phase re-prefills ~34K tokens: 87 client tool
 * schemas + the growing parent pile), an empty-delta chat.completion.chunk is emitted every
 * KEEP_ALIVE_TICK_MS so the client's stream idle-watchdog (observed aborting at ~30 s of
 * silence on opencode subagent calls) never fires. Real frames always take priority: a tick
 * only writes when no other data went out in the last tick window.
 */
const KEEP_ALIVE_TICK_MS = 5_000;
let idCounter = 0;

/**
 * Streaming sink for a single request. Callers write typed events through `writeEvent`;
 * the writer converts them into SSE frames and throws on disconnect (SC-023).
 */
export class SseWriter {
  private connected = true;
  private headersCommitted = false;
  private readonly reply: FastifyReply;
  private readonly logger: TraceLogger;
  /** Count of chat-completion.chunk frames emitted (logged at stream end for traceability). */
  frames = 0;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private lastActivityAt = Date.now();

  constructor(reply: FastifyReply, logger?: TraceLogger) {
    this.reply = reply;
    this.logger = logger ?? createLogger('sse');

    // SC-023: if the client drops mid-flight we can no longer write; mark disconnected
    // so any pending SSE event surfaces and callers abort immediately.
    this.reply.raw.on('close', () => {
      this.connected = false;
      this.stopKeepAlive();
    });
    // `finish` fires once the response is fully sent (raw.end() after [DONE]) — no keep-alives
    // may leak past stream end.
    this.reply.raw.on('finish', () => {
      this.stopKeepAlive();
    });

    // LAZY: nothing is committed here on purpose — not the SSE content-type, not a header, not a
    // byte. The SSE content-type + headers + status line all commit on the FIRST real frame
    // (commitHeaders below). A failure BEFORE the stream starts (e.g. the upstream is down) can
    // then still be answered with a clean JSON error: committing the content-type or writing the
    // `: connected` frame eagerly used to make the later `reply.code(5xx).send({...})` blow up
    // (invalid SSE payload / ERR_HTTP_HEADERS_SENT) and crash the process.
  }

  /** Commit the SSE content-type + stream headers exactly once, on the first real frame. */
  private commitHeaders(): void {
    if (this.headersCommitted) return;
    this.headersCommitted = true;
    // Fastify already flushes each `send` for streaming responses, so clients receive events in
    // real time without an explicit flush() call.
    this.reply.type('text/event-stream');
    this.reply.header('Cache-Control', 'no-cache, no-transform');
    this.reply.header('Connection', 'keep-alive');
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
    this.commitHeaders();
    try {
      this.reply.raw.write(text);
      this.lastActivityAt = Date.now();
      this.startKeepAlive();
    } catch (err) {
      // Client closed the connection or an error occurred mid-stream.
      this.connected = false;
      this.stopKeepAlive();
      throw err ?? new Error('client disconnect');
    }
  }

  /**
   * Start the idle keep-alive (idempotent; started after the first real frame, so the stream
   * headers are already committed and the client knows this is an SSE stream). Emits a valid
   * OpenAI chunk with an EMPTY delta while the wire has been silent for a whole tick — real
   * clients (Vercel AI SDK / opencode) treat an empty delta as a no-op, so the wire stays 100%
   * OpenAI while the client's read/idle watchdog keeps seeing activity.
   */
  private startKeepAlive(): void {
    if (this.keepAliveTimer) return;
    this.keepAliveTimer = setInterval(() => {
      if (!this.connected) {
        this.stopKeepAlive();
        return;
      }
      if (Date.now() - this.lastActivityAt < KEEP_ALIVE_TICK_MS) return;
      this.lastActivityAt = Date.now();
      try {
        // Deliberately bypasses safeWrite: a failing keep-alive must never throw out of the
        // interval callback — it just means the stream is over (stop and let the real frames
        // surface the disconnect normally).
        this.reply.raw.write(
          `data: ${JSON.stringify({
            id: this.id,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: 'evolve_proxy_default',
            choices: [{ index: 0, delta: {} }],
          })}\n\n`,
        );
      } catch {
        this.connected = false;
        this.stopKeepAlive();
      }
    }, KEEP_ALIVE_TICK_MS);
    // Never hold the process open (tests / clean shutdown).
    this.keepAliveTimer.unref?.();
  }

  /** Stop the keep-alive (stream ended, client gone, or explicit shutdown). */
  stopKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
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
    this.stopKeepAlive();
  }

  /** True once at least one assistant content delta has been flushed to the wire. */
  public hasEmittedContent(): boolean {
    return this.assistantTextStarted;
  }
}
