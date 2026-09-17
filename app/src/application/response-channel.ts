// ResponseChannel — the PORT through which the application layer answers the client.
//
// The chat-completion service emits through this interface and never touches a FastifyReply
// or an SseWriter; the presentation layer supplies the concrete implementation
// (`presentation/sse-channel.ts` — OpenAI chat-completion SSE frames over `reply.raw` plus
// the JSON replies of the non-stream path). Keeping the port here (not in the domain) is
// deliberate: the domain's `LoopSink` stays transport-agnostic, while this port names the
// concrete OpenAI-wire semantics the use case produces.

import type { LoopSink } from '../domain/agent-loop.js';
import type { SSEEvent, Phase } from '../domain/agent-events.js';
import type { TokenUsage, ToolCall } from '../domain/types.js';

export interface ResponseChannel {
  /** Has the client gone away? (Checked so a dead client is never written to.) */
  isDisconnected(): boolean;
  /** Append an OpenAI chat-completion delta: reasoning channel. */
  emitReasoningDelta(iteration: number, text: string): void;
  /** Append an OpenAI chat-completion delta: content channel. */
  emitContent(iteration: number, text: string): void;
  /** Append a chat-completion chunk carrying a `tool_calls` delta (the orchestrator spawn). */
  emitToolCalls(calls: ToolCall[]): void;
  /** Append the terminal chunk with a `finish_reason` (and authoritative `usage` when present). */
  emitFinish(finishReason: string, usage?: TokenUsage): void;
  /** Close the stream: terminal `[DONE]` marker + EOF on the same raw socket. */
  endStream(): void;
  /** Fail the in-flight streaming response without crashing (ADR A-012). */
  failStream(err: unknown): void;
  /** Send a complete OpenAI chat-completion JSON object (stream=false / compaction JSON). */
  sendCompletion(payload: Record<string, unknown>): void;
  /** Send the 502 JSON error payload for a failed non-stream upstream call. */
  sendUpstreamError(err: unknown): void;
  /** Number of frames already flushed (diagnostics / log lines). */
  readonly frames: number;
}

/**
 * LoopSink adapter over a ResponseChannel.
 *
 * The loop / orchestrator emit their `reasoning`/`phase` events here, but the OPENAI wire
 * carries NO custom SSE events — only deltas and finish. ADR A-008: the phase name is
 * folded into a small reasoning line (e.g. `[fase] interpretar (round 1)`) so a
 * client speaking plain OpenAI still receives real-time, ordered feedback; the actual
 * phase output then flows as ordinary `content` deltas (via `emitContent`) when it
 * streams. `writeEvent` / `emitPhase` are therefore intentionally dropped.
 */
export class ChannelSink implements LoopSink {
  constructor(private readonly channel: ResponseChannel) {}

  isDisconnected(): boolean {
    return this.channel.isDisconnected();
  }
  emitReasoning(iteration: number, text: string): void {
    this.channel.emitReasoningDelta(iteration, text);
  }
  emitReasoningDelta(iteration: number, delta: string): void {
    this.channel.emitReasoningDelta(iteration, delta);
  }
  emitContent(iteration: number, text: string): void {
    this.channel.emitContent(iteration, text);
  }
  emitToolCalls(calls: ToolCall[]): void {
    this.channel.emitToolCalls(calls);
  }
  writeEvent(_event: SSEEvent, _data: Record<string, unknown>): void {
    // Custom SSE events have no OpenAI-wire representation — intentionally dropped.
  }
  emitPhase(_phase: Phase, _extra?: Record<string, unknown>): void {
    // Folded into reasoning deltas by the callers (ADR A-008) — intentionally dropped.
  }
}
