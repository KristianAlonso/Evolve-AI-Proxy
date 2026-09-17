// Per-request scratch carried on the Fastify request between hooks and the chat handler:
// trace id (stable across every hook/handler/error of the request), start timestamp for the
// result line, and the stream type (filled in by the chat handler once the body is known).

import type { FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    requestMeta?: RequestMeta;
  }
}

export interface RequestMeta {
  start?: number;
  stream?: boolean;
  traceId?: string;
}

/** Lazily (in)create the request's scratch slot. */
export function getMeta(request: FastifyRequest): RequestMeta {
  if (!request.requestMeta) request.requestMeta = {};
  return request.requestMeta;
}
