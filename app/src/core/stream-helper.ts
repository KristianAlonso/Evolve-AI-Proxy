// Shared plumbing for real-time reasoning across every loop phase (FASE 1).
//
// Every upstream turn can be reached two ways: `completeStream` streams a v4 token stream and hands
// each arriving delta to a callback, while the buffered `complete()` returns one NormalizedResult
// when the stream completes. Both must yield the same shape to callers so no phase cares which
// transport produced it — a normalized result PLUS the ability to surface live reasoning deltas as
// they arrive upstream (SC-012 / FASE 1). This module makes that uniform: on the streaming path we
// accumulate the response in `onChunk` (so structured-output phases can still parse their final body
// from the SAME streamed call — no second round-trip). Buffered mode simply returns whatever
// `complete()` gives. Callers pass `surfaceDelta` only when they want live deltas on the wire; when
// it is omitted or a provider lacks `completeStream`, the phase stays fully buffered.

import type { ChatProvider, ProviderCallOptions, StreamChunk } from '../provider/types.js';
import type { NormalizedResult, ToolCall, UpstreamMessage } from '../types.js';

export interface CallWithStreamingInput {
  provider: ChatProvider;
  model: string | null;
  messages: UpstreamMessage[];
  options?: ProviderCallOptions;
  /** Optional. Invoked once per arriving live delta; omitted phases stay fully buffered (SC-012). */
  surfaceDelta?: (chunk: StreamChunk) => void;
}

export interface CallWithStreamingResult {
  result: NormalizedResult;
  /** True only when the provider streamed — callers can then skip a redundant post-hoc emit. */
  streamed: boolean;
}

/** A sink able to push one live reasoning delta toward the client (SC-012 / FASE 1). */
export interface LiveEmitter {
  /** Emit one incremental reasoning/thinking delta for the given loop iteration. */
  emitReasoningDelta(iteration: number, delta: string): void;
}

/** No-op surface callback, used as the default when a phase has no sink to stream through. */
const NOOP_SURFACE = (_chunk: StreamChunk): void => {};

/**
 * Run one upstream turn, streaming live deltas when possible and buffering otherwise.
 * On the streaming path both `reasoning` and `content` from each delta are accumulated so the
 * returned NormalizedResult is parseable just like a buffered `complete()` call would produce it.
 */
export async function callWithStreaming(input: CallWithStreamingInput): Promise<CallWithStreamingResult> {
  const { provider, model, messages, options } = input;

  // Only the streaming path is subtle. `completeStream` is an instance method whose body reads
  // `this` (e.g. `this.getClient()`), so it MUST be invoked with `provider` as its receiver — never
  // as a detached reference (`const f = p.completeStream`). A plain copy loses the binding and throws
  // "Cannot read properties of undefined" under strict mode, which is exactly how this helper used to
  // regress live forwarding while buffered `complete()` calls (always invoked on `provider`) never did.
  // We call it directly here so `this` stays bound; when the provider lacks streaming we fall through
  // to `complete()` below. Callers pass `surfaceDelta` only when they want live deltas; when omitted or
  // missing, the phase's structured output is still accumulated and parsed from the same streamed body.
  if (typeof provider.completeStream === 'function') {
    let accReasoning = '';
    let accContent = '';
    const accToolCalls: ToolCall[] = [];
    const surface = input.surfaceDelta ?? NOOP_SURFACE;
    await provider.completeStream(model, messages, {
      options,
      onChunk: (chunk) => {
        const reasoning = typeof chunk.reasoning === 'string' ? chunk.reasoning : '';
        const content = typeof chunk.content === 'string' ? chunk.content : '';
        accReasoning += reasoning;
        accContent += content;
        if (chunk.tool_call) accToolCalls.push(chunk.tool_call);
        surface(chunk);
      },
    });

    return {
      result: {
        content: accContent.trim() || null,
        reasoning: accReasoning,
        tool_calls: accToolCalls,
        refused: false,
        finish_reason: 'stop',
        raw: {},
      },
      streamed: true,
    };
  }

  const result = await provider.complete(model, messages, options);
  return { result, streamed: false };
}
