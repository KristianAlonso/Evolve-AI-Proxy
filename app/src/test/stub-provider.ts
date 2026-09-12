// In-memory ChatProvider stub for unit tests.
//
// Instead of handing out a fixed queue in order, it ROUTES by inspecting the incoming
// prompt so tests can drive each loop phase deterministically regardless of call count.
// This is what lets us assert on provider.calls without caring about exact ordering:
//   - interpreter prompt  -> a structured Interpretation JSON
//   - evaluator prompt     -> {complete:true} / {outcome:"still working"} (continue)
//   - planify prompt       -> a task description string
//   - anything else (execute) -> the given `output`
//
// A "no network" requirement — every call is served locally, no upstream access.

import type { ChatProvider, ProviderCallOptions, StreamChunk, UpstreamModel } from '../provider/types.js';
import type { NormalizedResult, ToolCall, UpstreamMessage } from '../types.js';

export interface StubRecord {
  model: string | null;
  messages: UpstreamMessage[];
}

/** Route a prompt to the response that best models the real upstream for that phase. */
type Router = (messages: UpstreamMessage[]) => NormalizedResult | Promise<NormalizedResult>;

const DEFAULT_EXECUTE: NormalizedResult = {
  content: 'Task succeeded.',
  reasoning: '',
  tool_calls: [],
  refused: false,
  finish_reason: 'stop',
  raw: {},
};

/** An AbortError-like rejection for a client stop (SC-023 / stop propagation). */
function abortError(reason?: unknown): Error {
  const e = new Error(`This operation was aborted: ${reason instanceof Error ? reason.message : String(reason ?? 'abort')}`);
  e.name = 'AbortError';
  return e;
}

/** Resolve like `p` but reject with AbortError if `signal` aborts first (client stop, SC-023). */
function respectAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(abortError(signal.reason));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal.reason));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

function baseRouter(opts?: {
  interpretation?: Record<string, unknown>;
  evalComplete?: boolean;
  output?: string | null;
  /** FASE 2: the execute step responds with native tool calls (delegated to the client). */
  toolCalls?: ToolCall[];
}): Router {
  return (messages: UpstreamMessage[]) => {
    const combined = messages.map((m) => m.content ?? '').join('\n');

    if (/interpreter of an agent loop/.test(combined)) {
      const interp =
        opts?.interpretation ??
        ({
          mainObjective: 'Complete the task',
          subObjectives: [],
          resourcesNeeded: [],
        }) as Record<string, unknown>;
      return { content: JSON.stringify(interp), reasoning: 'interpreted', tool_calls: [], refused: false, finish_reason: 'stop', raw: {} };
    }

    if (/Reply with EXACTLY one of/.test(combined)) {
      // Evaluator prompt. Avoid YES-word "complete"/"done" so a "continue" stays unambiguous.
      if (opts?.evalComplete) return { content: '{"complete": true}', reasoning: 'yes', tool_calls: [], refused: false, finish_reason: 'stop', raw: {} };
      return { content: '{"outcome":"still working"}', reasoning: 'not yet', tool_calls: [], refused: false, finish_reason: 'stop', raw: {} };
    }

    if (/planning the next concrete/.test(combined)) {
      return { content: 'Take the next step toward the goal.', reasoning: '', tool_calls: [], refused: false, finish_reason: 'stop', raw: {} };
    }

    const optsOutput = opts?.output;
    if (optsOutput === null || optsOutput === undefined) {
      // FASE 2: when the stub was told to request client-side tools, the execute step replies
      // with tool calls and null content (the model asked for tools, not plain text).
      if (opts?.toolCalls && opts.toolCalls.length > 0) {
        return { content: null, reasoning: 'using tools', tool_calls: opts.toolCalls, refused: false, finish_reason: 'tool_calls', raw: {} };
      }
      return { ...DEFAULT_EXECUTE, content: 'Task succeeded.' };
    }
    if (typeof optsOutput === 'string') return resp({ content: optsOutput });
    return { ...(optsOutput as unknown as NormalizedResult), reason_omitted: undefined };
  };
}

/** Build a StubProvider with the default router and given options. */
export function stub(opts?: {
  interpretation?: Record<string, unknown>;
  evalComplete?: boolean;
  output?: string | null;
  /** FASE 2: the execute step responds with native tool calls (delegated to the client). */
  toolCalls?: ToolCall[];
}): ChatProvider & { calls: StubRecord[] } {
  const record: StubRecord[] = [];
  const provider = baseRouter(opts);
  const complete = (model: string | null, messages: UpstreamMessage[], options?: ProviderCallOptions): Promise<NormalizedResult> => {
    record.push({ model, messages });
    // Stop propagation (SC-023): honour the caller's AbortSignal like the real provider's fetch.
    return respectAbort(Promise.resolve(provider(messages)), options?.abort_signal);
  };
  return Object.assign(
    {
      async listModels() {
        return [] as UpstreamModel[];
      },
      async validate() {},
      complete,
      calls: record,
    },
    provider,
  );
}

/**
 * A ChatProvider stub that ADDITIONALLY implements `completeStream`, delivering the routed result
 * as live chunks (one reasoning chunk, then one content chunk) so unit tests can exercise the loop's
 * streaming path (FASE 1: live reasoning from every phase). Routing is identical to `stub()`.
 */
export function streamingStub(opts?: {
  interpretation?: Record<string, unknown>;
  evalComplete?: boolean;
  output?: string | null;
  /** FASE 2: the execute step responds with native tool calls (delegated to the client). */
  toolCalls?: ToolCall[];
}): ChatProvider & { calls: StubRecord[] } {
  const router = baseRouter(opts);
  const record: StubRecord[] = [];
  return {
    async listModels() {
      return [] as UpstreamModel[];
    },
    async complete(model, messages, options?: ProviderCallOptions) {
      record.push({ model, messages });
      return respectAbort(Promise.resolve(router(messages)), options?.abort_signal);
    },
    async completeStream(model, messages, opts?: { options?: unknown; onChunk?: (c: StreamChunk) => void }) {
      record.push({ model, messages });
      const res = await respectAbort(Promise.resolve(router(messages)), (opts?.options as ProviderCallOptions | undefined)?.abort_signal);
      const onChunk = opts?.onChunk;
      if (!onChunk) return;
      const reasoning = res.reasoning ?? '';
      const content = res.content ?? '';
      if (reasoning !== '') onChunk({ reasoning });
      if (content !== '') onChunk({ content });
      // FASE 2: deliver each finalized tool call as its own chunk (complete, not incremental).
      for (const call of res.tool_calls) onChunk({ tool_call: call });
    },
    calls: record,
  };
}

/** Convenience builder for a NormalizedResult. */
export function resp(input: Partial<NormalizedResult> & { content?: string | null }): NormalizedResult {
  return { reasoning: '', tool_calls: [], refused: false, finish_reason: 'stop', raw: {}, ...input } as unknown as NormalizedResult;
}
