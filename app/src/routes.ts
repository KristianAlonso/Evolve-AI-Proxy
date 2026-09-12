// Fastify routes + app factory (ADRs A-001/A-002/A-003).
// Exports `createApp()` so the whole server can be instantiated for tests WITHOUT calling
// .listen() (import-safety from CLAUDE.md), and exposes streaming (SSE) and non-streaming
// OpenAI-compatible responses over POST /v1/chat/completions.
//
// SC-024: a preValidation hook validates every body up front and reports ALL issues at once.
// SC-016/SC-024: `model` is required (validateRequest rejects an empty string as 400 up-front),
//   so the handler always receives a concrete model — never "auto", never a proxy-chosen default.
//   Context-window size, when absent on the request, is then consulted from the API that serves
//   the model (/v1/models) rather than guessed here (SC-021/SC-022).
// SC-018: non-stream returns an OpenAI-style chat.completion JSON object; stream emits SSE
//         events (phases, reasoning, task results) through SseWriter during a single run().

import { mkdirSync, writeFileSync } from 'node:fs';
import { fastify as makeFastify } from 'fastify';import type {
  FastifyError,
  FastifyInstance,
  FastifyRequest,
  FastifyReply,
} from 'fastify';
import { createLogger, newTraceId, paint, statusColor, type TraceLogger } from './logger.js';
import { validateRequest, type ValidationResult } from './validate.js';
import { AgentLoop, type FinalResultData, type LoopOptions } from './core/agent-loop.js';
import { OpenAICompatibleProvider } from './provider/openai-compatible-provider.js';
import type { ChatProvider, UpstreamModel } from './provider/types.js';
import type { LoopSink } from './core/agent-loop.js';
import { SessionStore } from './core/session-store.js';
import { SseWriter } from './sse-writer.js';
import type { ProxyRequest, ToolCall, UpstreamMessage } from './types.js';
import type { LoopDecision } from './types.js';
import env from './config.js';

/**
 * One shared in-memory store for in-flight tool-delegation sessions (FASE 2). The whole
 * conversation travels in every request's `messages`, so the store only holds the small
 * pending-tool-call state; it is injectable via `CreateAppOptions.sessionStore` for tests.
 */
const defaultSessionStore = new SessionStore();

const logger = createLogger('http');

/** Map the orchestrator decision to an OpenAI finish_reason and refused flag (SC-018). */
function finishReason(decision: LoopDecision): { reason: string; refused: boolean } {
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
    default:
      return { reason: 'error', refused: true };
  }
}

/** OpenAI-compatible chat.completion object (SC-018) from a finished loop result. */
function toOpenAICompletion(model: string, finalResult: FinalResultData, traceId: string): Record<string, unknown> {
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
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
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

/**
 * Resolve the request's trace id: an incoming `x-trace-id` header is honoured (bounded to keep log
 * lines sane); otherwise the proxy mints one. Every log line of the request carries it, and it is
 * echoed back in the `x-trace-id` response header (and in `meta.trace_id` on the JSON path).
 */
function readTraceId(headers: Record<string, unknown>): string {
  const incoming = headers['x-trace-id'];
  if (typeof incoming === 'string' && incoming.length > 0 && incoming.length <= 128) return incoming;
  return newTraceId();
}

/**
 * Adapter so SseWriter (whose `isDisconnected` is a getter) satisfies LoopSink
 * (whose contract uses a call-style `isDisconnected()`). On the wire it emits ONLY valid OpenAI
 * chat-completion.chunk frames — proprietary named events never leave the socket, because an
 * OpenAI-compatible client (opencode / Vercel AI SDK) validates every data block against the
 * chat-completion schema and aborts on the first frame lacking `choices`.
 */
class SinkAdapter implements LoopSink {
  constructor(private readonly writer: SseWriter) {}

  isDisconnected(): boolean {
    return this.writer.isDisconnected; // getter -> call-style
  }

  emitReasoning(iteration: number, text: string): void {
    // Streaming reasoning arrives already broken into live deltas; fold a whole-run buffer in as
    // one reasoning delta so the client shows it without any proprietary event frame.
    this.writer.emitAiReasoningDelta(iteration, text);
  }

  emitReasoningDelta(iteration: number, delta: string): void {
    this.writer.emitAiReasoningDelta(iteration, delta);
  }

  emitContent(iteration: number, text: string): void {
    this.writer.emitAiContent(iteration, text);
  }

  emitToolCalls(calls: ToolCall[]): void {
    // FASE 2: delegate the upstream's tool calls to the client as OpenAI streaming chunks.
    this.writer.emitAiToolCalls(calls);
  }

  writeEvent(_event: Parameters<SseWriter['writeEvent']>[0], _data: Record<string, unknown>): void {
    // task_result / context_clear / tool_call_request carry nothing OpenAI clients should render on
    // this single-connection stream; their information already flows as reasoning/content deltas.
  }

  emitPhase(_phase: Parameters<SseWriter['emitPhase']>[0], _extra?: Record<string, unknown>): void {
    // Phases are proxy-internal progress signals (interpreting → planning → …). They have no OpenAI
    // chunk equivalent and would break schema validation, so they are dropped from the wire.
  }
}

/** Finalize an AI-compatible stream: emit a terminal finish chunk for the loop decision (SC-018). */
function finalizeAiStream(writer: SseWriter, decision: LoopDecision): void {
  writer.emitAiFinish(finishReason(decision).reason);
}

export interface CreateAppOptions {
  /** Injectable provider so tests can exercise routes against a stub. */
  provider?: ChatProvider;
  /** Base URL of the real upstream (used only when no provider is injected). */
  baseUrl?: string;
  /** Bearer token passed to the upstream (used only when no provider is injected). */
  apiKey?: string;
  /** Injectable tool-delegation session store (FASE 2) so tests can inspect/seed it. */
  sessionStore?: SessionStore;
}

/** Build and fully configure the Fastify server (routes + validation hook, NO listen). */
export async function createApp(options: CreateAppOptions = {}): Promise<FastifyInstance> {
  const app = makeFastify({ logger: false });
  logger.info('evolve_ai_proxy routes registered');

  // ---- /health ----
  app.get('/health', async () => ({ status: 'ok' }));

  // ---- Incoming-connection log: every request (any route) is logged with its remote address
  // ---- and trace id the moment it arrives, before any processing. The same `x-trace-id` header
  // ---- policy as the chat route: honoured from the client if sane, minted otherwise.
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const traceId = readTraceId(request.headers);
    reply.header('x-trace-id', traceId);
    // Per-request scratch for the onResponse summary (elapsed + stream type).
    (request as FastifyRequest & { requestMeta?: { start: number; stream: boolean | undefined; traceId?: string } }).requestMeta = {
      start: Date.now(),
      stream: undefined, // filled in by the chat handler once the body is known
      traceId,
    };
    const endpoint = request.routeOptions?.url ?? request.url;
    logger.traced(traceId).info(
      `incoming: ${request.ip} ${request.method} ${endpoint} (HTTP/${request.raw.httpVersion})`,
    );
  });

  // ---- Live colored request-result line (console only; the file keeps its plain audit lines). ----
  app.addHook('onResponse', async (request: FastifyRequest, reply: FastifyReply) => {
    const status = reply.statusCode;
    const endpoint = request.routeOptions?.url ?? request.url;
    const streamType = (request as FastifyRequest & { requestMeta?: { stream?: boolean } }).requestMeta?.stream;
    const streamLabel = streamType === undefined ? paint('stream=-', 'cyan') : paint(streamType ? 'stream=yes' : 'stream=no', streamType ? 'cyan' : 'magenta');
    const elapsed = Date.now() - ((request as FastifyRequest & { requestMeta?: { start?: number } }).requestMeta?.start ?? Date.now());
    const fileMsg = `request completed: ${request.method} ${endpoint} (HTTP/${request.raw.httpVersion}) stream=${streamType === undefined ? '-' : streamType ? 'yes' : 'no'} -> ${status} elapsed=${elapsed}ms`;
    const consoleLine = `${request.ip} ${request.method} ${endpoint} (HTTP/${request.raw.httpVersion}) ${streamLabel} -> ${statusColor(status)} (${elapsed}ms)`;
    // Correlate with the exact trace id the client saw (onRequest's, or the chat handler's once
    // it re-stamps it) so the result line joins the same grep family.
    const traceId = (request as FastifyRequest & { requestMeta?: { traceId?: string } }).requestMeta?.traceId;
    (traceId ? createLogger('http').traced(traceId) : createLogger('http')).requestResult(fileMsg, consoleLine);
  });

  // ---- Every error — malformed JSON from the body parser (which dies BEFORE preValidation can
  // ---- inspect it), validation 400s, and unexpected 500s — is logged with its trace id and
  // ---- answered with Fastify's standard error body. No error is ever a silent 4xx/5xx. ----
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const traceId = readTraceId(request.headers);
    const status = error.statusCode && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    logger.traced(traceId).error(
      `error ${status} on ${request.method} ${request.url}: ${error.message}`,
    );
    if (status < 500) {
      reply.status(status).send({
        statusCode: status,
        code: error.code,
        error: status === 400 ? 'Bad Request' : String(status),
        message: error.message,
      });
    } else {
      reply.status(500).send({
        statusCode: 500,
        code: error.code,
        error: 'Internal Server Error',
        message: 'An internal error occurred',
      });
    }
  });

  // ---- SC-024: validate ALL request fields at once, before any loop logic runs. ----
  app.addHook('preValidation', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.url.startsWith('/v1/chat/completions')) return;
    const traceId = readTraceId(request.headers);
    reply.header('x-trace-id', traceId);
    const result: ValidationResult = validateRequest(request.body);
    if (result.ok) return;
    const message = result.issues.map((i) => `${i.field}: ${i.message}`).join('; ');
    logger.traced(traceId).error(`request rejected (400 validation): ${message}`);
    throw Object.assign(new Error(message), { statusCode: 400, httpCode: 400 });
  });

  app.post('/v1/chat/completions', async (request, reply) => {
    // Tracing (SC-025): one trace id per request, threaded through every layer (routes -> loop ->
    // provider -> SSE writer) and echoed back so clients can correlate logs with their requests.
    const traceId = readTraceId(request.headers);
    const log: TraceLogger = logger.traced(traceId);
    reply.header('x-trace-id', traceId);
    const requestStart = Date.now();

    const body = request.body as Partial<ProxyRequest>;
    // Record the stream type + final trace id for the onResponse result line.
    (request as FastifyRequest & { requestMeta?: { stream?: boolean; traceId?: string } }).requestMeta!.stream = !!body.stream;
    (request as FastifyRequest & { requestMeta?: { traceId?: string } }).requestMeta!.traceId = traceId;

    // Stop propagation (SC-023): one AbortController per request. When the client interrupts the
    // connection — a hard disconnect or the user asking the model to STOP (opencode cuts the HTTP
    // stream) — it is aborted: the in-flight upstream API call is cancelled (no more tokens
    // generated for a dead client) and the AgentLoop breaks at its next checkpoint.
    const abortController = new AbortController();
    reply.raw.once('close', () => {
      if (!reply.raw.writableEnded) {
        log.warn(`client aborted: trace_id=${traceId} — cancelling upstream call and stopping AgentLoop`);
        abortController.abort('client disconnect');
      }
    });

    const provider: ChatProvider =
      options.provider ?? new OpenAICompatibleProvider(options.baseUrl, options.apiKey, undefined, log);

    log.info(
      `POST /v1/chat/completions: model="${(body.model ?? '').trim()}" stream=${!!body.stream} ` +
      `messages=${(body.messages ?? []).length} tools=${body.tools?.length ?? 0} ` +
      `tool_choice=${body.tool_choice ?? '-'} session=${sessionIdOf(request)}`,
    );
    captureRequest({ traceId, request, body, log });

    // The model comes from the request body, and only from `body.model` — there is no header-based
    // override on this route. It still stands alone for every client, so resolveUpstreamModel() maps
    // it against `/v1/models` as before (SC-016/SC-024 + AUTO_RESOLVE_MODEL). No custom header reads the model.
    const model: string = (body.model ?? '').trim();

    // Fetch the upstream `/v1/models` listing AT MOST once per request and thread it through both
    // subsystems that need it. Without this memo, `resolveContextWindow` (window lookup) AND
    // `resolveUpstreamModel` (alias resolution) each called `provider.listModels()` on a cold cache,
    // hitting `/v1/models` twice per request instead of once — and an empty auto-resolve path a third.
    let modelsCache: Promise<UpstreamModel[]> | null = null;
    const readModelsOnce = (p: ChatProvider): Promise<UpstreamModel[]> => {
      if (!modelsCache) {
        modelsCache = (async () => {
          try {
            const list = await p.listModels();
            return Array.isArray(list) ? list : [];
          } catch {
            /* metadata unavailable — an empty list defers cleanly to body/default handling */
            return [];
          }
        })();
      }
      return modelsCache;
    };

    const concreteModel = await resolveUpstreamModel(model, await readModelsOnce(provider));
    const models = await readModelsOnce(provider);
    const resolution = describeModelResolution(model, concreteModel, models);
    log.info(`model resolution: "${model}" -> "${concreteModel}" (${resolution})`);

    // Map evolve controls down to orchestrator options. `tools`/`tool_choice` carry the client's
    // delegated tools (FASE 2): only the loop's execute step forwards them to the upstream.
    const loopOpts: LoopOptions = {
      max_rounds: body.max_rounds ?? 10,
      max_retries: body.max_retries ?? 3,
      doom_loop_threshold: body.doom_loop_threshold ?? 4,
      context_window_size: await resolveContextWindow(await readModelsOnce(provider), body),
      model: concreteModel,
      tools: body.tools,
      tool_choice: body.tool_choice,
      logger: log,
      traceId,
      abort_signal: abortController.signal,
    };
    log.info(`loop configured: max_rounds=${loopOpts.max_rounds} max_retries=${loopOpts.max_retries} context_window=${loopOpts.context_window_size}`);

    const messages = (body.messages ?? []) as UpstreamMessage[];

    // The natural-language instruction for the loop. A request with no user/system turn is
    // structurally invalid, so validation rejects it as 400 up-front (SC-016/SC-024) before any
    // loop work runs — we therefore always reach here with an actionable message to act on.
    const instruction = firstText(messages);

    // FASE 2: the bidirectional session rides the standard `x-session-id` header (opencode's
    // x-goog-session-id style affinity header, captured from the opencode upstream dump).
    const rawSessionId = request.headers['x-session-id'];
    const sessionId = typeof rawSessionId === 'string' && rawSessionId.length > 0 ? rawSessionId : undefined;
    const store = options.sessionStore ?? defaultSessionStore;

    if (body.stream) {
      const finalResult = await handleStream(provider, reply as unknown as FastifyReply, loopOpts, messages, instruction, log, traceId);
      if (finalResult) {
        log.info(
          `request done (stream): decision=${finalResult.decision} iterations=${finalResult.iterations_completed} ` +
          `upstream_calls=${finalResult.reasoning_traces_summary.total_upstream_calls} elapsed=${Date.now() - requestStart}ms`,
        );
        toolDelegateBookkeeping(store, sessionId, concreteModel, body, finalResult, log);
      }
      return; // SseWriter has already written frames + ended the stream.
    } else {
      const finalResult = await runLoop(provider, undefined, loopOpts, messages, instruction);
      toolDelegateBookkeeping(store, sessionId, concreteModel, body, finalResult, log);
      log.info(
        `request done: decision=${finalResult.decision} iterations=${finalResult.iterations_completed} ` +
        `upstream_calls=${finalResult.reasoning_traces_summary.total_upstream_calls} elapsed=${Date.now() - requestStart}ms`,
      );
      reply.send(toOpenAICompletion(concreteModel, finalResult, traceId));
    }
  });

  return app;
}

/**
 * FASE 2 bookkeeping: when the loop paused on delegated tool calls, record the pending state under
 * the request's session id; on any terminal decision, clear a session that was awaiting a resume.
 * A resume (assistant tool_calls + tool results re-sent on the same session) needs no explicit
 * flag — the conversation transcript already carries the exchange.
 */
function toolDelegateBookkeeping(
  store: SessionStore,
  sessionId: string | undefined,
  model: string,
  body: Partial<ProxyRequest>,
  finalResult: FinalResultData,
  log: TraceLogger,
): void {
  if (!sessionId) return;
  if (finalResult.decision === 'tool_calls_pending') {
    store.save({
      sessionId,
      model,
      tools: body.tools,
      tool_choice: body.tool_choice,
      pendingToolCalls: finalResult.tool_calls,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    log.info(`session store: saved pending tool delegation for session=${sessionId} (${finalResult.tool_calls.length} call(s))`);
  } else {
    store.delete(sessionId);
    log.info(`session store: cleared session=${sessionId} (terminal decision=${finalResult.decision})`);
  }
}

/** Log-friendly summary of how the incoming model id resolved (exact / auto-resolve / fallback). */
function describeModelResolution(bodyModel: string, concrete: string, models: UpstreamModel[]): string {
  if (concrete === bodyModel) return 'exact';
  if (models.some((m) => m.id === concrete)) return 'auto-resolve';
  return 'fallback';
}

/**
 * Debugging interceptor (SC-025 companion): dump the FULL incoming request to one JSON file under
 * `env.CAPTURE_DIR`, named `<utc-timestamp>_<traceId>.json`. Lets us inspect exactly what a client
 * (e.g. opencode) sent — every tool schema, every message — to diagnose issues like the execute
 * phase overflowing a small model's context window. Never crashes the request; disabled with
 * `CAPTURE_REQUESTS=false`.
 */
function captureRequest(params: {
  traceId: string;
  request: FastifyRequest;
  body: Partial<ProxyRequest>;
  log: TraceLogger;
}): void {
  if (!env.CAPTURE_REQUESTS) return;
  try {
    const body = params.body;
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const raw = JSON.stringify(body);
    // Very rough token estimate (~4 chars/token) — good enough to spot a 100k-token request blow-up.
    const charCount = raw.length;
    const entry = {
      trace_id: params.traceId,
      timestamp: new Date().toISOString(),
      ip: params.request.ip,
      method: params.request.method,
      url: params.request.url,
      session: sessionIdOf(params.request),
      headers: sanitizeHeaders(params.request.headers),
      summary: {
        model: body.model ?? '',
        stream: !!body.stream,
        message_count: messages.length,
        messages: messages.map((m) => ({
          role: m.role,
          chars: typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content ?? null)?.length ?? 0,
          tool_calls: Array.isArray(m.tool_calls) ? m.tool_calls.length : 0,
          tool_call_id: m.tool_call_id ?? null,
        })),
        tool_count: tools.length,
        tool_names: tools.map((t) => t.function.name),
        tool_choice: body.tool_choice ?? null,
        body_chars: charCount,
        est_tokens: Math.round(charCount / 4),
      },
      body,
    };
    mkdirSync(env.CAPTURE_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = `${env.CAPTURE_DIR}/${stamp}_${params.traceId}.json`;
    writeFileSync(file, JSON.stringify(entry, null, 2));
    params.log.info(`request captured to ${file} (est ${entry.summary.est_tokens} tokens, ${tools.length} tools)`);
  } catch (err) {
    params.log.warn(`request capture failed: ${String(err)}`);
  }
}

/** Headers minus secrets: Authorization/api keys are masked so captures are safe to share. */
function sanitizeHeaders(headers: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (typeof v !== 'string') continue;
    out[key] = key === 'authorization' || key === 'x-api-key' || key === 'proxy-authorization'
      ? `<redacted ${v.length} chars>`
      : v;
  }
  return out;
}

/** Session id from the standard affinity header, or '-' for the request log line. */
function sessionIdOf(request: FastifyRequest): string {
  const raw = request.headers['x-session-id'];
  return typeof raw === 'string' && raw.length > 0 ? raw : '-';
}

/** Run the agent loop without a sink (non-stream path). */
async function runLoop(
  provider: ChatProvider,
  sink: LoopSink | undefined,
  opts: LoopOptions,
  messages: UpstreamMessage[],
  instruction: string,
): Promise<FinalResultData> {
  const loop = new AgentLoop(provider, sink, opts);
  const result = await loop.run(instruction, messages);
  return result.finalResult;
}

/** SSE stream handler: write valid OpenAI chat-completion chunks as the single loop run progresses. */
async function handleStream(
  provider: ChatProvider,
  reply: FastifyReply,
  opts: LoopOptions,
  messages: UpstreamMessage[],
  instruction: string,
  log: TraceLogger,
  traceId: string,
): Promise<FinalResultData | undefined> {
  const writer = new SseWriter(reply, log);
  const sink = new SinkAdapter(writer);
  const streamStart = Date.now();
  log.info(`stream start: frames so far=0`);
  try {
    // Extract the final decision off the loop result so we can emit a matching finish chunk.
    const result = await runLoop(provider, sink, opts, messages, instruction);
    finalizeAiStream(writer, result.decision);
    // Flush the terminating frame on the same socket as every other stream frame — Fastify would
    // drop `reply.send` here just like any later `send`, so [DONE] must go out via raw.write.
    reply.raw.write('data: [DONE]\n\n');
    // raw.write bypasses Fastify's response-lifecycle, so the socket is never marked complete on its
    // own — end() flushes the final bytes and signals EOF to the client (and to `inject()`), which a
    // normal SSE stream does when it finishes. Without this the reply stays pending forever.
    reply.raw.end();
    log.info(`stream end: frames=${writer.frames} elapsed=${Date.now() - streamStart}ms decision=${result.decision}`);
    return result;
  } catch (err) {
    if (!sink.isDisconnected()) {
      log.error(`stream error (frames=${writer.frames}, elapsed=${Date.now() - streamStart}ms): ${String(err)}`);
      try {
        reply.code(500).send({ error: 'agent loop failed', detail: String(err), trace_id: traceId });
      } catch {
        /* stream already partially sent; the client likely disconnected */
      }
    } else {
      log.warn(`stream aborted by client disconnect: frames=${writer.frames} elapsed=${Date.now() - streamStart}ms`);
    }
  }
  return undefined;
}

/** First user/system message text — the natural-language instruction for the loop. */
/**
 * Build the natural-language instruction for the loop: the full system prompt (all `system`
 * turns, in order) followed by the first `user` turn's content. The agent must act on both —
 * never drop the system context, and never run without a concrete user instruction.
 */
function firstText(messages: UpstreamMessage[]): string {
  const system = messages
    .filter((m) => m.role === 'system' && typeof m.content === 'string')
    .map((m) => m.content)
    .join('\n');
  const user = messages.find(
    (m) => m.role === 'user' && typeof m.content === 'string',
  )?.content;

  // Validation guarantees at least one system OR user message exists, so this is never empty in
  // practice. Prefer the explicit system prompt when present (it defines *how* to act), and fall
  // back to the first available turn's content if it is missing.
  if (system && user) return `${system}\n\n${user}`;
  return system || user || '';
}

/**
 * Resolve the upstream context-window size for this request (SC-021 / SC-022).
 *
 * Resolution order, per product rule — "the maximum window must be consulted from the API that
 * serves the model" ONLY when the request does not declare one:
 *   1) an explicit `body.context_window_size` on the request (no upstream call);
 *   2) otherwise `/v1/models` advertised `max_input_tokens` for this model — the provider serving
 *      it is authoritative;
 *   3) unlimited (`0`) when neither is available: the loop never stalls over missing metadata, and
 *      a zero window disables proxy-side condensation so the upstream enforces its own real cap —
 *      whose error propagates to the client exactly as designed.
 *
 * Never throws: a hiccup on `/v1/models` falls through rather than blocking real work. `listModels()`
 * is cached by the provider, so this does not add cost beyond one warm round-trip per run.
 */
async function resolveContextWindow(
  models: UpstreamModel[],
  body: Partial<ProxyRequest>,
): Promise<number> {
  // (1) Honour a size explicitly declared on the request — short-circuit BEFORE any upstream call.
  const explicit = body.context_window_size;
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit >= 0) {
    return explicit;
  }

  // (2) Otherwise ask the API that serves the model — authoritative per-model cap if advertised.
  const fromUpstream = await resolveSizeFromProvider(models, (body.model ?? '').trim());
  if (fromUpstream !== undefined && fromUpstream >= 0) return fromUpstream;

  // (3) Terminal fallback: unlimited window. Proxy-side condensation stays off; the upstream caps it.
  return 0;
}

/** Read a positive context-window size from `/v1/models` (undefined when absent/invalid). */
async function resolveSizeFromProvider(
  models: UpstreamModel[],
  model: string,
): Promise<number | undefined> {
  // Prefer the exact-model entry so a per-model cap wins over whatever else is listed.
  let entry = models.find((m) => m.id === model);
  if (!entry) {
    const candidates = models.filter((m) => !m.mode || /chat|text/.test(String(m.mode)));
    entry = candidates[0];
  }

  const n = entry?.max_input_tokens ?? undefined;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Resolve an incoming model id to a concrete upstream model, so the loop never forwards an id that
 * LiteLLM does not recognize — opencode's alias (`evolve_proxy/default`) and any unknown id used to
 * fail every step before the first call (`upstream_calls:0`, decision `error`).
 *
 * Resolution order per SC-016/SC-024 intent and config `AUTO_RESOLVE_MODEL`:
 *   1) if the request names an id that exists on `/v1/models`, pass it straight through (never guess);
 *   2) otherwise, when auto-resolve is enabled, pick the first upstream chat/text model — authoritative
 *      to whatever the provider actually serves;
 *   3) terminal fallback to config `FALLBACK_MODEL`.
 *
 * `models` is the single `/v1/models` fetch already threaded in from the handler — passing the array
 * here (rather than re-calling `provider.listModels()`) keeps every lookup on one cold round-trip per
 * request. Never throws: it reads a cached list and falls back gracefully instead of breaking work.
 */
async function resolveUpstreamModel(
  bodyModel: string,
  models: UpstreamModel[],
): Promise<string> {
  const concrete = (bodyModel ?? '').trim();

  // Prefer an existing upstream id verbatim — never guess when the user named a real one.
  if (concrete) {
    if (models.some((m) => m.id === concrete)) return concrete;
  }

  if (!env.AUTO_RESOLVE_MODEL) return env.FALLBACK_MODEL;

  for (const m of models) {
    const mode = String(m.mode ?? '');
    if (/chat|text/i.test(mode)) return m.id;
  }
  return env.FALLBACK_MODEL;
}

export default createApp;
