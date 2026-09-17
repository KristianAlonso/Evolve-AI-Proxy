// The presentation's ResponseChannel implementation: OpenAI chat-completion SSE frames over
// `reply.raw` (through the lazy SseWriter, ADR A-012) plus the JSON replies of the non-stream
// path. This is the only place the application-facing port touches Fastify.

import type { FastifyReply } from 'fastify';
import { upstreamErrorPayload } from '../application/openai-completion.js';
import type { ResponseChannel } from '../application/response-channel.js';
import type { TraceLogger } from '../domain/logging.js';
import type { TokenUsage, ToolCall } from '../domain/types.js';
import { SseWriter } from './sse-writer.js';

/**
 * Fail a streaming response without crashing.
 *
 * If the response has NOT been committed yet (no headers sent — the SseWriter is lazy and only
 * commits on the FIRST real frame, ADR A-012) a clean JSON 502 is still possible and exactly
 * what OpenAI-compatible clients expect. If frames are already flushed, a status code can no
 * longer be expressed (a second writeHead throws `ERR_HTTP_HEADERS_SENT` and used to crash the
 * process): terminate in-band with an error frame + `[DONE]` + EOF so the client sees an errored
 * stream, never a corrupt/hanging response.
 */
export function terminateStreamWithError(
  reply: FastifyReply,
  err: unknown,
  traceId: string,
  log: TraceLogger,
): void {
  const detail = String(err);
  if (!reply.raw.headersSent) {
    reply.code(502).send(upstreamErrorPayload(detail, traceId));
    return;
  }
  try {
    reply.raw.write(
      `data: ${JSON.stringify({
        error: { message: 'upstream stream failed', type: 'upstream_error', detail, trace_id: traceId },
        choices: [],
      })}\n\n`,
    );
    reply.raw.write('data: [DONE]\n\n');
    reply.raw.end();
  } catch {
    // The socket is already gone — make sure nothing hangs open.
    try {
      reply.raw.destroy();
    } catch {
      /* already closed */
    }
  }
}

/**
 * SSE + JSON response channel. The SseWriter is created lazily on the first frame: constructing
 * it has no side effects (ADR A-012) and a pre-stream failure can therefore still be answered
 * with a clean JSON 502. Disconnect detection is attached eagerly (a `close` listener on the
 * raw response) so the loop can stop even when no frame was ever flushed.
 */
export class SseResponseChannel implements ResponseChannel {
  private writer?: SseWriter;
  private clientClosed = false;

  constructor(
    private readonly reply: FastifyReply,
    private readonly log: TraceLogger,
    private readonly traceId: string,
  ) {
    this.reply.raw.once('close', () => {
      this.clientClosed = true;
    });
  }

  /** Lazily create the SseWriter on first use (see class comment). */
  private writerRef(): SseWriter {
    if (!this.writer) this.writer = new SseWriter(this.reply, this.log);
    return this.writer;
  }

  isDisconnected(): boolean {
    return this.clientClosed || this.writer?.isDisconnected === true;
  }

  emitReasoningDelta(iteration: number, text: string): void {
    this.writerRef().emitAiReasoningDelta(iteration, text);
  }

  emitContent(iteration: number, text: string): void {
    this.writerRef().emitAiContent(iteration, text);
  }

  emitToolCalls(calls: ToolCall[]): void {
    this.writerRef().emitAiToolCalls(calls);
  }

  emitFinish(finishReason: string, usage?: TokenUsage): void {
    this.writerRef().emitAiFinish(finishReason, usage);
  }

  get frames(): number {
    return this.writer?.frames ?? 0;
  }

  /** Close the stream: terminal `[DONE]` marker + EOF on the same raw socket. */
  endStream(): void {
    this.reply.raw.write('data: [DONE]\n\n');
    this.reply.raw.end();
  }

  failStream(err: unknown): void {
    terminateStreamWithError(this.reply, err, this.traceId, this.log);
  }

  sendCompletion(payload: Record<string, unknown>): void {
    this.reply.send(payload);
  }

  sendUpstreamError(err: unknown): void {
    this.reply.code(502).send(upstreamErrorPayload(String(err), this.traceId));
  }
}
