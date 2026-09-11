// Auto-healing retry (FR-008 / SC-013, SC-014).
// On failure (throw) or a runaway repeat (doom-loop detected), re-invoke up to maxRetries.
// Each failed attempt is recorded as a separate trace; when retries are exhausted we emit an
// error event + partial result (SC-013). The caller's runStep should use buildAutocorrectPrompt
// so each heal targets the specific prior error.

import type { TaskResult } from '../types.js';
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
}

/**
 * Run an execution step with automatic recovery. `runStep` executes the model once and
 * throws on failure or returns { output, reasoning }. Returns a TaskResult plus per-attempt traces (SC-013/014).
 */
export async function withAutoHealingRetry(
  runStep: () => Promise<{ output: string; reasoning: string }>,
  options: {
    maxRetries?: number; // default 3 (SC-013)
    doomLoopThreshold?: number; // SC-012
  },
): Promise<WithRetryOutcome> {
  const maxRetries = options.maxRetries ?? 3;
  const threshold = options.doomLoopThreshold ?? 4;

  const traces: RetryAttemptTrace[] = [];
  let attempts = 0;
  let lastDoomed: DoomLoopResult = { detected: false, repetitions: 0 };
  let lastError = '';

  // First attempt, then up to `maxRetries` healing retries. SC-013/014: every failed attempt that
  // triggers a heal is recorded as a separate trace. The terminal (exhausted) attempt surfaces only
  // through the returned status/error and never adds another row to `traces`.
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const exhausted = attempt > maxRetries;

    try {
      const { output, reasoning } = await runStep();
      attempts++;
      const doomed = detectDoomLoop(reasoning || output, threshold);
      lastDoomed = doomed;

      if (!doomed.detected) {
        // Recovered cleanly — still report the failures that preceded success. SC-013/014.
        return finishSuccess(output, reasoning, attempts, doomed, traces);
      }

      // A runaway repeat: heal it (trace + retry) unless we have already exhausted retries. SC-012.
      if (exhausted) break;
      traces.push({ attempt, error: `doom-loop detected (${doomed.repeatedPhrase ?? 'repeated phrase'})`, reasoning });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      lastError = error;
      if (exhausted) return finishFailure(attempts, traces, error, lastDoomed);
      traces.push({ attempt, error, reasoning: '' });
    }
  }

  // Should not normally reach here; guard for exhausted loop without throw. SC-012/013.
  return finishFailure(attempts, traces, lastError || 'step failed', lastDoomed);
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
  };
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
