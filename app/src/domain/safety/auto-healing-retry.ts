// Auto-healing retry (FR-008 / SC-013, SC-014).
// On failure (throw) or a runaway repeat (doom-loop detected), re-invoke up to maxRetries.
// Each failed attempt is recorded as a separate trace; when retries are exhausted we emit an
// error event + partial result (SC-013). The caller's runStep should use buildAutocorrectPrompt
// so each heal targets the specific prior error.

import type { TaskResult, ToolCall } from '../types.js';
import { detectDoomLoop, type DoomLoopResult } from './doom-loop-detector.js';

export interface RetryAttemptTrace {
  attempt: number;
  error: string;
  reasoning: string;
}

export interface WithRetryOutcome {
  result: TaskResult;      // completed | failed (partial on exhaustion)
  doomedLoop: DoomLoopResult;
  traces: RetryAttemptTrace[];
  /** Native tool calls the step requested (FASE 2) — empty when the step produced plain text. */
  tool_calls: ToolCall[];
}

/**
 * Run an execution step with automatic recovery. `runStep` executes the model once and
 * throws on failure or returns { output, reasoning }. Returns a TaskResult plus per-attempt traces (SC-013/014).
 */
export async function withAutoHealingRetry(
  runStep: () => Promise<{ output: string; reasoning: string; tool_calls?: ToolCall[] }>,
  options: {
    maxRetries?: number; // default 3 (SC-013)
    doomLoopThreshold?: number; // SC-012
    /** Stop propagation (SC-023): when the client aborts mid-run, an aborted upstream call must
     * NOT burn the retry budget — fail fast with the abort error. */
    abortSignal?: AbortSignal;
  },
): Promise<WithRetryOutcome> {
  const maxRetries = options.maxRetries ?? 3;
  const threshold = options.doomLoopThreshold ?? 4;

  const traces: RetryAttemptTrace[] = [];
  let attempts = 0;
  let lastDoomed: DoomLoopResult = { detected: false, repetitions: 0 };
  let lastError = '';
  let lastToolCalls: ToolCall[] = [];

  // First attempt, then up to `maxRetries` healing retries. SC-013/014: every failed attempt that
  // triggers a heal is recorded as a separate trace. The terminal (exhausted) attempt surfaces only
  // through the returned status/error and never adds another row to `traces`.
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const exhausted = attempt > maxRetries;

    try {
      const { output, reasoning, tool_calls } = await runStep();
      if (tool_calls) lastToolCalls = tool_calls;
      attempts++;
      const doomed = detectDoomLoop(reasoning || output, threshold);
      lastDoomed = doomed;

      if (!doomed.detected) {
        // Recovered cleanly — still report the failures that preceded success. SC-013/014.
        const outcome = finishSuccess(output, reasoning, attempts, doomed, traces);
        outcome.tool_calls = lastToolCalls;
        return outcome;
      }

      // A runaway repeat: heal it (trace + retry) unless we have already exhausted retries. SC-012.
      if (exhausted) break;
      traces.push({ attempt, error: `doom-loop detected (${doomed.repeatedPhrase ?? 'repeated phrase'})`, reasoning });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      lastError = error;
      // Deterministic upstream errors (bad request, context-window overflow, auth) fail
      // identically on every retry — burning the retry budget on them just adds latency with
      // zero chance of healing. Aborted calls are the same: the client stopped, retrying a dead
      // request is pointless. Fail fast with the original error in all three cases.
      if (options.abortSignal?.aborted || isDeterministicUpstreamError(error) || exhausted) {
        return finishFailure(attempts, traces, error, lastDoomed);
      }
      traces.push({ attempt, error, reasoning: '' });
    }
  }

  // Should not normally reach here; guard for exhausted loop without throw. SC-012/013.
  const outcome = finishFailure(attempts, traces, lastError || 'step failed', lastDoomed);
  outcome.tool_calls = lastToolCalls;
  return outcome;
}

function finishSuccess(
  output: string,
  reasoning: string,
  attempts: number,
  doomedLoop: DoomLoopResult,
  failedTraces: RetryAttemptTrace[],
): WithRetryOutcome {
  return {
    result: { id: '', status: 'completed', output, reasoning, attempts },
    doomedLoop,
    traces: failedTraces.slice(),
    tool_calls: [],
  };
}

function finishFailure(
  attempts: number,
  traces: RetryAttemptTrace[],
  error: string,
  doomedLoop: DoomLoopResult,
): WithRetryOutcome {
  const reasoning = traces
    .map((t) => `attempt ${t.attempt}: error - ${t.error}`)
    .join('\n');

  return {
    result: { id: '', status: 'failed', output: '', reasoning, attempts, error },
    doomedLoop,
    traces,
    tool_calls: [],
  };
}

/**
 * True for upstream errors where re-sending the SAME request cannot possibly succeed: bad
 * requests, context-window overflows, auth failures, unknown models. (429 is borderline — we
 * treat it as deterministic too, since this retry has no backoff and would hammer the same
 * rate limit.)
 */
export function isDeterministicUpstreamError(error: string): boolean {
  return /abort|ContextWindowExceeded|exceeds the available context size|context (window|length)|invalid[_ ]api[_ ]key|Unauthorized|HTTP 4\d\d|\b40[0134]\b|BadRequest|UnsupportedOperation|model_not_found|UnknownModel/i.test(error);
}

/** Build an autocorrecting prompt that names the specific error (SC-013). */
export function buildAutocorrectPrompt(originalInstruction: string, error: string): string {
  return [
    'Original instruction:',
    ` ${originalInstruction}`,
    '',
    'The previous attempt failed with this error:',
    ` ${error}`,
    '',
    'Re-run the task. Be precise and avoid whatever caused that failure.',
  ].join('\n');
}
