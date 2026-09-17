// Incoming-request capture (SC-025 companion): dump the FULL incoming request to one JSON
// file under `env.CAPTURE_DIR`, named `<utc-timestamp>_<traceId>.json`. Lets us inspect exactly
// what a client (e.g. opencode) sent — every tool schema, every message — to diagnose issues
// like the execute phase overflowing a small model's context window. Never crashes the request;
// disabled with `CAPTURE_REQUESTS=false`.

import { mkdirSync, writeFileSync } from 'node:fs';
import env from './config.js';
import type { TraceLogger } from '../domain/logging.js';
import type { ProxyRequest } from '../domain/types.js';

export interface CapturedRequestSource {
  ip: string;
  method: string;
  url: string;
}

/**
 * Persist the incoming request as a full JSON artifact (see module comment). The file name embeds
 * the SAME `traceId` used across the whole request log — so the request capture, the upstream
 * call captures and the log lines all share one id.
 */
export function captureIncomingRequest(params: {
  traceId: string;
  remote: CapturedRequestSource;
  headers: Record<string, unknown>;
  sessionId: string;
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
      ip: params.remote.ip,
      method: params.remote.method,
      url: params.remote.url,
      session: params.sessionId,
      headers: sanitizeHeaders(params.headers),
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
export function sanitizeHeaders(headers: Record<string, unknown>): Record<string, string> {
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
