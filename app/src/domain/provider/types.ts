// Provider interface + upstream shapes. The core loop depends on ChatProvider, not
// on the concrete OpenAI-compatible implementation, so tests can inject a stub.

import type { NormalizedResult, ToolCall, ToolChoice, ToolDefinition, UpstreamMessage } from '../types.js';
import type { TraceLogger } from '../logging.js';

/** A model advertised by /v1/models (only what we need from it). */
export interface UpstreamModel {
  id: string;
  mode?: 'chat' | 'embedding' | string;
  max_input_tokens?: number;
}

/** Extra knobs a provider call may accept. */
export interface ProviderCallOptions {
  /**
   * Passthrough-intacto (ADR A-007): the client request's body fields, verbatim, MINUS
   * messages/model/stream/tools/tool_choice and the evolve proxy controls. The provider forwards
   * them to the upstream exactly as the client sent them: recognized fields are mapped into
   * provider v4 options (temperature, top_p, max_tokens, seed, stop, frequency_penalty,
   * presence_penalty); every other field (top_k, logprobs, stream_options, user, metadata,
   * service_tier, parallel_tool_calls, reasoning_effort, response_format, ...) rides raw into the
   * upstream request body through the SDK's providerOptions. The proxy NEVER invents values —
   * no field set by the client means no field sent.
   */
  passthrough?: Record<string, unknown>;
  /** Client-side tools to delegate (FASE 2); forwarded to the upstream `tools` parameter. */
  tools?: ToolDefinition[];
  tool_choice?: ToolChoice;
  /**
   * Traced request logger (SC-025). Passed per call so a shared/singleton provider still logs every
   * upstream request under the trace id of the request that triggered it. Not forwarded upstream —
   * provider-internal only; `forwardOptions()` ignores it.
   */
  logger?: TraceLogger;
  /**
   * Request trace id (SC-025). Used to name upstream request/response captures so one `grep`-able
   * file family per trace id. Provider-internal only; `forwardOptions()` ignores it.
   */
  trace_id?: string;
  /**
   * Abort signal that cancels the in-flight upstream call (stop propagation, SC-023): when the
   * client interrupts (disconnect or an explicit "stop"), the routes layer aborts it and the
   * provider's underlying fetch is cancelled. Provider-internal only.
   */
  abort_signal?: AbortSignal;
}

/**
 * True when an error is an AbortError (fetch/stream cancelled through an AbortSignal — client
 * stop). Duck-typed on name/message (no instanceof): SDKs throw AbortError instances that may
 * not share the local Error prototype chain.
 */
export function isAbortError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: string; message?: string };
  return e.name === 'AbortError' || /abort/i.test(e.name ?? '') || /abort/i.test(e.message ?? '');
}

/**
 * A single chunk of output delivered during streaming mode. All fields are optional because an
 * upstream delta may carry only thinking text, only assistant text, only a finalized tool call, or
 * (for the terminal delta) none. The consumer is expected to accumulate across chunks rather than
 * treat one as complete.
 */
export interface StreamChunk {
  reasoning?: string | null; // reasoning/thinking produced by this delta ('' when none)
  content?: string | null;   // assistant text produced by this delta ('' when none)
  /** A finalized native tool call requested by the model (FASE 2); one chunk per tool call. */
  tool_call?: ToolCall | null;
}

/**
 * A minimal chat completion abstraction for the agent loop.
 * The concrete OpenAICompatibleProvider hits the upstream target; tests use an in-memory stub.
 */
export interface ChatProvider {
  /** List models advertised by upstream (used to resolve a default model, SC-019). */
  listModels(): Promise<UpstreamModel[]>;
  /** Run one non-streaming completion and normalize it into a provider-agnostic result. */
  complete(
    model: string | null,
    messages: UpstreamMessage[],
    options?: ProviderCallOptions,
  ): Promise<NormalizedResult>;

  /**
   * Optional SSE token stream of the same response `complete` would produce (SC-009). Called ONLY on
   * the streaming path and only when the provider supports it — a missing method means callers fall
   * back to buffered `complete()`. Each newly-produced chunk is handed to `onChunk` as soon as it
   * arrives upstream so an orchestrator can stream live reasoning AND detect runaway repeats (SC-012)
   * while the model still generates. The promise resolves once the stream completes (or throws on a
   * non-2xx response, whose error then propagates to the client).
   */
  /** Optional config for `completeStream`: per-call knobs plus the chunk callback. */
  completeStream?(
    model: string | null,
    messages: UpstreamMessage[],
    opts?: { options?: ProviderCallOptions; onChunk: (chunk: StreamChunk) => void },
  ): Promise<void>;
}
