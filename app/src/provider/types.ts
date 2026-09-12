// Provider interface + upstream shapes. The core loop depends on ChatProvider, not
// on the concrete OpenAI-compatible implementation, so tests can inject a stub.

import type { NormalizedResult, ToolCall, ToolChoice, ToolDefinition, UpstreamMessage } from '../types.js';

/** A model advertised by /v1/models (only what we need from it). */
export interface UpstreamModel {
  id: string;
  mode?: 'chat' | 'embedding' | string;
  max_input_tokens?: number;
}

/** Extra knobs a provider call may accept. */
export interface ProviderCallOptions {
  max_tokens?: number | null;
  temperature?: number;
  /** Client-side tools to delegate (FASE 2); forwarded to the upstream `tools` parameter. */
  tools?: ToolDefinition[];
  tool_choice?: ToolChoice;
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
