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

import type { ChatProvider, UpstreamModel } from '../provider/types.js';
import type { NormalizedResult, UpstreamMessage } from '../types.js';

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

function baseRouter(opts?: {
  interpretation?: Record<string, unknown>;
  evalComplete?: boolean;
  output?: string | null;
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
}): ChatProvider & { calls: StubRecord[] } {
  const record: StubRecord[] = [];
  const provider = baseRouter(opts);
  const complete = (model: string | null, messages: UpstreamMessage[]): Promise<NormalizedResult> => {
    record.push({ model, messages });
    return Promise.resolve(provider(messages));
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

/** Convenience builder for a NormalizedResult. */
export function resp(input: Partial<NormalizedResult> & { content?: string | null }): NormalizedResult {
  return { reasoning: '', tool_calls: [], refused: false, finish_reason: 'stop', raw: {}, ...input } as unknown as NormalizedResult;
}
