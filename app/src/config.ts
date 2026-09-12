// Static config + runtime wiring for the evolve proxy.
// SC-019 (provider validation) is enforced by the provider layer; here we hold
// defaults, env overrides and helpers for resolving an upstream model list.

export interface Env {
  /** Base URL of the OpenAI-compatible upstream (LiteLLM target). */
  UPSTREAM_BASE_URL: string;
  /** Bearer token passed to the upstream on every call. */
  UPSTREAM_API_KEY: string;
  HTTP_PORT: number;
  HTTP_HOST: string;
  /** When a request omits `model`, resolve one from /v1/models instead of guessing. */
  AUTO_RESOLVE_MODEL: boolean;
  /** Fallback model id if upstream has no listed chat models to choose from. */
  FALLBACK_MODEL: string;
  LOG_DIR: string;
  /** Mirror every log line to the console (stdout/stderr) — on by default. */
  CONSOLE_LOG: boolean;
  /** Directory where full incoming requests are captured for debugging (one JSON file per request). */
  CAPTURE_DIR: string;
  /** Whether to capture incoming requests to disk at all. */
  CAPTURE_REQUESTS: boolean;
}

const env: Env = {
  UPSTREAM_BASE_URL: process.env.UPSTREAM_BASE_URL ?? 'http://26.238.135.219:4000',
  UPSTREAM_API_KEY: process.env.UPSTREAM_API_KEY ?? '',
  HTTP_PORT: Number(process.env.HTTP_PORT ?? 8787),
  HTTP_HOST: process.env.HTTP_HOST ?? '0.0.0.0',
  AUTO_RESOLVE_MODEL: (process.env.AUTO_RESOLVE_MODEL ?? 'true') === 'true',
  FALLBACK_MODEL: process.env.FALLBACK_MODEL ?? 'gemini/gemini-2.5-flash',
  LOG_DIR: process.env.LOG_DIR ?? './logs',
  CONSOLE_LOG: (process.env.CONSOLE_LOG ?? 'true') === 'true',
  CAPTURE_DIR: process.env.CAPTURE_DIR ?? './captures',
  CAPTURE_REQUESTS: (process.env.CAPTURE_REQUESTS ?? 'true') === 'true',
};

export default env;
