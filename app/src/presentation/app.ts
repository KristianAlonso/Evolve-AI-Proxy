// Composition of the HTTP edge (presentation layer): the Fastify instance, its lifecycle
// hooks, and the thin POST /v1/chat/completions adapter that parses the request into a
// ChatCompletionInput and hands it to the application service. This file wires — it does not
// decide; every pipeline decision lives in `application/chat-completion-service.ts`.

import { fastify as makeFastify, type FastifyInstance } from 'fastify';
import { createLogger } from '../infrastructure/logger.js';
import env from '../infrastructure/config.js';
import type { ChatProvider } from '../domain/provider/types.js';
import { OpenAICompatibleProvider } from '../infrastructure/provider/openai-compatible-provider.js';
import { SessionStore } from '../domain/session-store.js';
import type { ProxyRequest } from '../domain/types.js';
import { ChatCompletionService } from '../application/chat-completion-service.js';
import { SseResponseChannel } from './sse-channel.js';
import { readTraceId, registerHooks } from './hooks.js';
import { getMeta } from './request-meta.js';

const logger = createLogger('http');

/**
 * One shared in-memory store for in-flight tool-delegation sessions (FASE 2). The whole
 * conversation travels in every request's `messages`, so the store only holds the small
 * pending-tool-call state; it is injectable via `CreateAppOptions.sessionStore` for tests.
 */
const defaultSessionStore = new SessionStore();

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

/** Build and fully configure the Fastify server (routes + hooks, NO listen). */
export async function createApp(options: CreateAppOptions = {}): Promise<FastifyInstance> {
  // Fat clients (opencode with 100-200+ tool schemas) send multi-MB request bodies; Fastify's
  // 1MB default turns them into intermittent 413s mid-session. 16MB leaves headroom for the
  // biggest observed clients (~1MB per request) plus long conversations.
  const app = makeFastify({ logger: false, bodyLimit: 16 * 1024 * 1024 });
  logger.info('evolve_ai_proxy routes registered');
  registerHooks(app, logger);

  // ---- /health (SC-019) — liveness probe -------------------------------------
  app.get('/health', async () => ({ status: 'ok' }));

  const service = new ChatCompletionService({
    sessionStore: options.sessionStore ?? defaultSessionStore,
    compactThreshold: env.CONTEXT_COMPACT_THRESHOLD,
  });

  // ---- POST /v1/chat/completions (ADR A-005, A-006, A-007, A-008) -------------
  app.post('/v1/chat/completions', async (request, reply) => {
    // Tracing (SC-025): one trace id per request, threaded through every layer and echoed back
    // so clients can correlate logs with their requests.
    const traceId = readTraceId(request);
    const log = logger.traced(traceId);
    reply.header('x-trace-id', traceId);

    const body = request.body as Partial<ProxyRequest>;
    // Record the stream type + final trace id for the onResponse result line.
    const meta = getMeta(request);
    meta.stream = !!body.stream;
    meta.traceId = traceId;

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

    // One provider per request so its upstream calls trace under THIS request's logger.
    const provider: ChatProvider =
      options.provider ?? new OpenAICompatibleProvider(options.baseUrl, options.apiKey, undefined, log);

    const rawSessionId = request.headers['x-session-id'];
    const sessionId = typeof rawSessionId === 'string' && rawSessionId.length > 0 ? rawSessionId : undefined;

    await service.handle({
      provider,
      body,
      stream: !!body.stream,
      sessionId,
      traceId,
      log,
      abort: abortController.signal,
      channel: new SseResponseChannel(reply, log, traceId),
      remote: { ip: request.ip, method: request.method, url: request.url },
      headers: request.headers as Record<string, unknown>,
    });
  });

  return app;
}

export default createApp;
