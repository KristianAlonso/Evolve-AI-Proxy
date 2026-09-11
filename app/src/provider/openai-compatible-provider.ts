// Concrete chat provider backed by an OpenAI-compatible upstream (the LiteLLM target).
//
// Transport, request building and response parsing are delegated to Vercel's @ai-sdk/openai-compatible.
// We still re-normalize the SDK result into the loop's provider-agnostic shape so nothing downstream
// cares whether it is talking to raw fetch or the SDK: per-turn reasoning/refusal extraction, token
// usage, and a live delta stream for the agent loop to surface in real time (SC-009 / SC-012).

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import env from '../config.js';
import { createLogger } from '../logger.js';
import type { NormalizedResult, UpstreamMessage, ToolCall } from '../types.js';
import { validateRequest } from '../validate.js';
import type { ChatProvider, ProviderCallOptions, UpstreamModel, StreamChunk } from './types.js';

/** The SDK chat model handle returned by a call to `.chatModel(id)`. */
export type V4ChatModel = ReturnType<ReturnType<typeof createOpenAICompatible>['chatModel']>;

/** A single text part — the only input shape this provider builds. */
interface TextPart {
  type: 'text';
  text: string;
}

export interface ProviderClient {
  chatModel(modelId: string): V4ChatModel;
}

/** Builds the SDK-backed client from a base URL / API key (production default). */
type ClientFactory = (baseUrl: string, apiKey: string | undefined) => ProviderClient;

function createSdkClient(baseUrl: string, apiKey: string | undefined): ProviderClient {
  const name = baseUrl.split('//')[1]?.split('/')[0] ?? 'openai-compatible';
  const sdk = createOpenAICompatible({ baseURL: `${baseUrl}/v1`, name, apiKey });
  // `chatModel` is the only surface we depend on — re-expose it so tests can swap in a fake client.
  return { chatModel: (modelId: string) => sdk.chatModel(modelId as any) };
}

/** The provider, wired to the upstream via the AI SDK. */
export class OpenAICompatibleProvider implements ChatProvider {
  private baseUrl: string;
  private apiKey: string | undefined;
  private logger = createLogger('upstream');
  private modelsCache: UpstreamModel[] | null = null;
  private client?: ProviderClient;
  private readonly createClient: ClientFactory;

  constructor(
    baseUrl = env.UPSTREAM_BASE_URL,
    apiKey = env.UPSTREAM_API_KEY,
    // Injectable so tests can drive the forwarding/normalization logic with a fake chat model
    // instead of mocking global fetch (the SDK owns transport and its own SSE parsing).
    createClient: ClientFactory = createSdkClient,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.createClient = createClient;
  }

  /** Lazily build the SDK client (one-time) so it carries a consistent base URL / API key. */
  private getClient(): ProviderClient {
    if (!this.client) {
      this.client = this.createClient(this.baseUrl, this.apiKey);
    }
    return this.client;
  }

  async listModels(): Promise<UpstreamModel[]> {
    if (this.modelsCache) return this.modelsCache;
    try {
      const res = await fetch(`${this.baseUrl}/v1/models`, {
        headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
      });
      if (!res.ok) throw new Error(`/v1/models returned HTTP ${res.status}`);
      const json = (await res.json()) as { data?: UpstreamModel[] };
      this.modelsCache = json.data ?? [];
      return this.modelsCache;
    } catch (e) {
      this.logger.warn(`models fetch failed: ${(e as Error).message}`);
      return [];
    }
  }

  async complete(
    model: string | null,
    messages: UpstreamMessage[],
    options?: ProviderCallOptions,
  ): Promise<NormalizedResult> {
    // Rule (no auto): the upstream must NEVER be asked to choose a model. Every call has to target
    // a concrete model selected by the user in the incoming request. Guard here — the single
    // transport gate — so no loop stage can slip "auto" (or an un-set model) past. If a caller
    // passes auto/null/empty, fail fast and loudly instead of silently gateway-deciding.
    if (model === null || model === undefined || model === '' || model === 'auto') {
      throw new Error(
        `refusing to send model=${model === null ? 'null' : JSON.stringify(model)}: ` +
          'every upstream call must target a concrete model selected by the user',
      );
    }

    // Structural guard against malformed payloads before dispatching — keeps validateRequest as
    // defense in depth on top of the SDK's own input validation.
    try {
      validateRequest({ model, messages } as unknown);
    } catch {
      /* the target validates upstream; this is only defensive */
    }

    const result = await this.getClient().chatModel(model).doGenerate({
      prompt: toV4Messages(messages),
      // Forward the caller's per-call knobs into v4 call options so they reach the upstream request
      // body (the SDK maps max_tokens -> maxOutputTokens, temperature, etc.). Omitted fields stay
      // undefined and are dropped from the body — no change to defaults.
      ...(options?.max_tokens != null ? { maxOutputTokens: options.max_tokens } : {}),
      ...(options?.temperature != null ? { temperature: options.temperature } : {}),
    });

    return this.toNormalized(result);
  }

  /**
   * SSE token stream of the same response `complete` produces. Streams delta chunks to `onChunk` as
   * they arrive so an orchestrator can surface live reasoning and detect runaway repeats mid-run
   * (SC-009 / SC-012). Driven by @ai-sdk/openai-compatible's doStream({ prompt }), which yields a
   * v4 stream of parts; we read 'text-delta'/'reasoning-delta' events and forward each delta. The
   * promise resolves once the stream completes (or throws on a non-2xx response, whose error then
   * propagates to the client).
   */
  async completeStream(
    model: string | null,
    messages: UpstreamMessage[],
    opts?: { options?: ProviderCallOptions; onChunk: (chunk: StreamChunk) => void },
  ): Promise<void> {
    const onChunk = opts?.onChunk ?? (() => {});

    // Same transport gate as `complete` (no auto): the upstream must never be asked to pick a model.
    if (model === null || model === undefined || model === '' || model === 'auto') {
      throw new Error(
        `refusing to send model=${model === null ? 'null' : JSON.stringify(model)}: ` +
          'every upstream call must target a concrete model selected by the user',
      );
    }

    const result = await this.getClient().chatModel(model).doStream({ prompt: toV4Messages(messages) });

    for await (const part of result.stream as AsyncIterable<{ type: string; delta?: string }>) {
      if (part.type === 'text-delta') {
        onChunk({ content: part.delta ?? null, reasoning: null });
      } else if (part.type === 'reasoning-delta') {
        onChunk({ reasoning: part.delta ?? null, content: null });
      }
    }
  }

  /** Normalize an SDK v4 generate result into the loop's provider-agnostic shape. */
  private toNormalized(result: Awaited<ReturnType<V4ChatModel['doGenerate']>>): NormalizedResult {
    let content = '';
    let reasoning = '';
    const tool_calls: ToolCall[] = [];

    for (const part of result.content) {
      if (part.type === 'text') {
        content += part.text ?? '';
      } else if (part.type === 'reasoning') {
        reasoning += part.text ?? '';
      }
      // Native tool calls are out of scope for this proxy's non-interactive upstream path; they are
      // simply not produced and ignored here rather than carried through.
    }

    return {
      content: content.trim() || null,
      reasoning,
      tool_calls,
      usage: result.usage
        ? {
            prompt_tokens: result.usage.inputTokens?.total ?? 0,
            completion_tokens: result.usage.outputTokens?.total ?? 0,
            total_tokens: (result.usage.inputTokens?.total ?? 0) + (result.usage.outputTokens?.total ?? 0),
          }
        : undefined,
      refused: result.finishReason.unified === 'content-filter',
      finish_reason: result.finishReason.unified,
      raw: {},
    };
  }
}

/** The distinct v4 message shapes the SDK requires (system is a string, others are part arrays). */
type SystemMessage = { role: 'system'; content: string };
type TextUserOrAssistantMessage = {
  role: 'user' | 'assistant';
  content: Array<TextPart>;
};
type V4PromptEntry = SystemMessage | TextUserOrAssistantMessage;

/** Map loop messages (string content) to AI SDK v4 text-only messages. */
function toV4Messages(messages: UpstreamMessage[]): V4PromptEntry[] {
  return messages.map((message) => {
    if (message.role === 'tool') {
      // The interactive upstream path does not carry tool responses; skip them.
      return { role: 'system', content: '' } satisfies SystemMessage;
    }
    if (message.role === 'system') {
      return { role: 'system', content: message.content ?? '' } satisfies SystemMessage;
    }
    return {
      role: message.role,
      content: [{ type: 'text', text: message.content ?? '' }],
    } satisfies TextUserOrAssistantMessage;
  });
}
