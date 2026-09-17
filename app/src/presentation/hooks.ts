// Fastify lifecycle hooks (presentation layer): the incoming-connection log, the live
// colored request-result line, up-front body validation (SC-024), and the global error
// handler. Registered on the app instance by the composition root (`app.ts`).

import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createLogger, newTraceId, paint, statusColor, type TraceLogger } from '../infrastructure/logger.js';
import { validateRequest, type ValidationResult } from '../domain/validation.js';
import { getMeta } from './request-meta.js';

/**
 * Resolve the request's trace id: an incoming `x-trace-id` header is honoured (bounded to keep log
 * lines sane); otherwise the proxy mints one. Every log line of the request carries it, and it is
 * echoed back in the `x-trace-id` response header (and in `meta.trace_id` on the JSON path).
 */
export function readTraceId(request: FastifyRequest): string {
  const meta = getMeta(request);
  if (meta.traceId) return meta.traceId;
  const incoming = request.headers['x-trace-id'];
  const traceId =
    typeof incoming === 'string' && incoming.length > 0 && incoming.length <= 128
      ? incoming
      : newTraceId();
  meta.traceId = traceId;
  return traceId;
}

/**
 * Register every Fastify hook and the error handler on `app`:
 *
 * - `onRequest`: honors (or mints) the `trace_id`, stores the start time and echoes the header.
 *   Every request — including unauthenticated `/` or `/health` — leaves a line.
 * - `onResponse`: the "request completed" line (INFO, console-only mirror).
 * - `preValidation`: validate the body BEFORE anything else; a 400 is thrown with a precise message.
 * - `setErrorHandler`: turn any error (validation, parser, unexpected) into a logged 4xx/5xx
 *   with the `trace_id` echoed in the response body.
 */
export function registerHooks(app: FastifyInstance, logger: ReturnType<typeof createLogger>): void {
  // ---- onRequest: mint/adopt the trace id, stamp start time, echo the header, log the hit. ----
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const traceId = readTraceId(request);
    reply.header('x-trace-id', traceId);
    const meta = getMeta(request);
    meta.start = Date.now();
    meta.stream = undefined;
    const endpoint = request.routeOptions?.url ?? request.url;
    const plainIncoming = `incoming: ${request.ip} ${request.method} ${endpoint} (HTTP/${request.raw.httpVersion})`;
    const coloredIncoming = `incoming: ${request.ip} ${paint(request.method, 'magenta')} ${paint(endpoint, 'cyan')} (HTTP/${request.raw.httpVersion})`;
    logger.traced(traceId).info(plainIncoming, coloredIncoming);
  });

  // ---- onResponse: the colored, console-only "request result" line (INFO level). ----
  app.addHook('onResponse', async (request: FastifyRequest, reply: FastifyReply) => {
    const status = reply.statusCode;
    const endpoint = request.routeOptions?.url ?? request.url;
    const streamType = getMeta(request).stream;
    const streamLabel = streamType === undefined
      ? paint('stream=-', 'cyan')
      : paint(streamType ? 'stream=yes' : 'stream=no', streamType ? 'cyan' : 'magenta');
    const elapsed = Date.now() - (getMeta(request).start ?? Date.now());
    const fileMsg = `request completed: ${request.method} ${endpoint} (HTTP/${request.raw.httpVersion}) stream=${streamType === undefined ? '-' : streamType ? 'yes' : 'no'} -> ${status} elapsed=${elapsed}ms`;
    const consoleLine = `${request.ip} ${request.method} ${endpoint} (HTTP/${request.raw.httpVersion}) ${streamLabel} -> ${statusColor(status)} (${elapsed}ms)`;
    const traceId = getMeta(request).traceId;
    (traceId ? createLogger('http').traced(traceId) : createLogger('http')).requestResult(fileMsg, consoleLine);
  });

  // ---- Global error handler (SC-024, ADR A-012) ---------------------------------
  // Every error — bad JSON, 400 validation, 500 internal — is logged with its trace id and
  // answered with the standard Fastify body. If the response was ALREADY committed
  // (headersSent — e.g. an upstream failure after SSE frames were flushed), a second
  // writeHead throws ERR_HTTP_HEADERS_SENT and crashes the process: close the socket
  // instead so the client simply sees the stream end (the in-band error frame was already
  // sent by the streaming path).
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const traceId = readTraceId(request);
    const status = error.statusCode && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    logger.traced(traceId).error(`error ${status} on ${request.method} ${request.url}: ${error.message}`);
    if (reply.raw.headersSent) {
      reply.raw.end();
      return;
    }
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

  // ---- preValidation: schema-validate the body BEFORE any handler runs. ----
  app.addHook('preValidation', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.url.startsWith('/v1/chat/completions')) return;
    const traceId = readTraceId(request);
    reply.header('x-trace-id', traceId);
    const result: ValidationResult = validateRequest(request.body);
    if (result.ok) return;
    const message = result.issues.map((i) => `${i.field}: ${i.message}`).join('; ');
    logger.traced(traceId).error(`request rejected (400 validation): ${message}`);
    throw Object.assign(new Error(message), { statusCode: 400, httpCode: 400 });
  });
}
