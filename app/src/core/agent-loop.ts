// The agent loop orchestrator (the heart of ADR A-003).
// Flow: interpret -> generate task(s) -> execute (with auto-healing + doom-loop guard) ->
// evaluate binary decision -> (context condensing) -> repeat until complete or max_rounds.
// Emits typed SSE events through a LoopSink; results are also returned for the non-stream path.

import type { ChatProvider } from '../provider/types.js';
import { createLogger } from '../logger.js';
import type { Phase, SSEEvent } from '../sse-writer.js';
import type { AgentTask, LoopDecision, TaskResult, UpstreamMessage } from '../types.js';
import { interpretRequest, type Interpretation } from './interpreter.js';
import { generateTasks } from './task-generator.js';
import { evaluateTask } from './evaluator.js';
import { withAutoHealingRetry } from '../safety/auto-healing-retry.js';
import { ContextManager, type ContextStep } from './context-manager.js';
import { detectDoomLoop, type DoomLoopResult } from '../safety/doom-loop-detector.js';

/** Minimal sink the orchestrator writes to. Structurally satisfied by SseWriter AND a test sink. */
export interface LoopSink {
  isDisconnected(): boolean;
  emitReasoning(iteration: number, text: string): void;
  /** Emit one live reasoning delta during streaming mode (SC-012). */
  emitReasoningDelta(iteration: number, delta: string): void;
  /** Emit one live assistant-text delta as an OpenAI chat-completion.chunk during streaming (dual path). */
  emitContent(_iteration: number, _text: string): void;
  writeEvent(event: SSEEvent, data: Record<string, unknown>): void;
  emitPhase(phase: Phase, extra?: Record<string, unknown>): void;
}

/** Options the orchestrator is given (defaults match SC-012/SC-013/SC-017/SC-022). */
export interface LoopOptions {
  max_rounds?: number; // SC-017
  max_retries?: number; // SC-013
  doom_loop_threshold?: number; // SC-012
  context_window_size: number; // SC-022
  model?: string | null;
}

export interface LoopTrace {
  iteration: number;
  phase: Phase;
  task_id?: string;
  content: string;
}

export interface FinalResultData {
  final_output: string;
  iterations_completed: number;
  decision: LoopDecision;
  max_rounds: number;
  tasks_executed: Array<{ id: string; status: TaskResult['status']; output?: string }>;
  reasoning_traces_summary: {
    phases_completed: Phase[];
    total_upstream_calls: number;
    errors_occurred: number;
  };
  accumulated_context: string;
}

/** One self-contained execution attempt inside the auto-healing wrapper. */
type ExecStep = () => Promise<{ output: string; reasoning: string; doomedLoop: DoomLoopResult }>;

export class AgentLoop {
  private provider: ChatProvider;
  private sink?: LoopSink;
  private logger;
  private ctxManager = new ContextManager(4096);
  private phaseSet = new Set<Phase>();
  /** Live upstream-call counter (SC-018). */
  totalUpstreamCalls = 0;

  constructor(provider: ChatProvider, sink?: LoopSink, opts: Partial<LoopOptions> = {}) {
    this.provider = provider;
    this.sink = sink;
    this.opts = opts;
    this.ctxManager.setWindowSize(opts.context_window_size ?? 4096);
    this.logger = createLogger('loop');
  }

  async run(
    originalInstruction: string,
    messages: UpstreamMessage[],
  ): Promise<{ decision: LoopDecision; finalResult: FinalResultData; trace: LoopTrace[] }> {
    const o = this.resolvedOptions();
    if (o.max_rounds < 1) throw new Error('max_rounds must be >= 1');

    let decision: LoopDecision = 'continue';
    const trace: LoopTrace[] = [];
    const accumulatedSteps: ContextStep[] = [];
    let lastOutput = '';
    let round = 0;

    for (; round < o.max_rounds; round++) {
      try {
        if (this.sink?.isDisconnected()) break; // SC-023: abort before any upstream call

        // ---- Interpret phase (SC-004): ask the model to interpret, surface structured reasoning. ----
        this.phaseSet.add('interpreting');
        this.emitPhase('interpreting', { step: 'interpret' });
        const interp = await interpretRequest(this.provider, [...messages], () => '', { model: o.model });
        if (this.sink) this.sink.emitReasoning(0, interp.reasoning || interp.interpretation.mainObjective);

        // ---- Initial task generation from the interpretation (SC-005). ----
        let tasks = await generateTasks(this.provider, originalInstruction, interp.interpretation);

        // ---- Planning / task selection. Consume pre-generated tasks in order, refine when out. ----
        this.emitPhase('planning', { step: 'planify' });
        const task = tasks[round] ?? await this.planify(nextGoalHint(originalInstruction, lastOutput));
        trace.push({ iteration: round + 1, phase: 'planning', task_id: task.id, content: task.description });

        // ---- Execute with auto-healing + doom-loop guard (SC-012/013/014). ----
        this.emitPhase('executing_task', { step: `execute #${round + 1}` });
        const executeStep: ExecStep = async () => {
          const prompt = [
            ...this.buildContextPrompt(originalInstruction, accumulatedSteps),
            { role: 'user' as const, content: task.description },
          ];

          // On the stream path (sink present) AND when the provider can actually stream, run with a
          // live SSE token stream so reasoning reaches the client in real time. The buffered call is
          // used otherwise — including every one of the unit tests' stubbed providers.
          const streaming = Boolean(this.sink) && typeof this.provider.completeStream === 'function';
          if (!streaming) {
            this.countCall('execute');
            const res = await this.provider.complete(o.model, prompt, {});
            return { output: res.content ?? '', reasoning: res.reasoning || '', doomedLoop: { detected: false, repetitions: 0 } };
          }

          // ---- Streaming attempt: stream live thinking + detect a runaway while it generates. ----
          let accReasoning = '';
          let accContent = '';
          let lastDoomed: DoomLoopResult = { detected: false, repetitions: 0 };

          const completeStream = this.provider.completeStream; // narrow optional method off the loop field so flow narrowing holds inside the closure below.
          if (!completeStream) return { output: '', reasoning: '', doomedLoop: lastDoomed };

          await completeStream(o.model, prompt, { options: {}, onChunk: (chunk) => {
            const delta = chunk.reasoning ?? null;
            const textDelta = delta == null ? '' : delta;
            accReasoning += textDelta;

            // Live reasoning trace to the client — incremental per arriving delta.
            if (this.sink && textDelta !== '') this.sink.emitReasoningDelta(round + 1, textDelta);
            if (typeof chunk.content === 'string' && chunk.content !== '') {
              accContent += chunk.content;
              // Surface live assistant text so the OpenAI client reconstructs the answer as it arrives.
              this.sink?.emitContent(round + 1, chunk.content);
            }

            // Detect a doom-loop mid-generation so we can abort the fetch instead of waiting for the
            // whole answer to arrive. detectDoomLoop is the same pure function used post-hoc below.
            const doomed = detectDoomLoop(accReasoning + accContent, o.doom_loop_threshold);
            if (doomed.detected) lastDoomed = doomed;
          }});

          return { output: accContent, reasoning: accReasoning, doomedLoop: lastDoomed };
        };

        let outcome;
        try {
          outcome = await withAutoHealingRetry(executeStep, {
            maxRetries: o.max_retries,
            doomLoopThreshold: o.doom_loop_threshold,
          });
        } catch (err) {
          this.logger.error(`execute failed: ${String(err)}`);
          decision = 'error';
          break;
        }

        const result: TaskResult = outcome.result;
        if (result.status === 'failed') {
          decision = 'refusal_exhausted';
          trace.push({ iteration: round + 1, phase: 'error', content: result.error ?? 'step failed after retries' });
          break;
        }

        if (this.sink) this.sink.writeEvent('task_result', { task_id: result.id, output: result.output });
        if (outcome.doomedLoop.detected && this.sink) {
          trace.push({ iteration: round + 1, phase: 'executing_task', content: `doom-loop detected: ${outcome.doomedLoop.repeatedPhrase ?? ''}` });
        }

        lastOutput = result.output;
        const step: ContextStep = {
          iteration: round + 1,
          objective: interp.interpretation.mainObjective,
          task_id: result.id,
          output: result.output,
          successful: true,
        };
        accumulatedSteps.push(step);
        this.ctxManager.record(step);

        // ---- Binary evaluation (SC-007/008). ----
        this.emitPhase('evaluating', { step: `evaluate #${round + 1}` });
        const evalCall = await evaluateTask(this.provider, originalInstruction, this.accumulatedSummary(accumulatedSteps), result, { model: o.model });
        this.countCall('evaluate');
        if (this.sink) this.sink.emitReasoning(round + 1, `${evalCall.reasoning}\n-> ${evalCall.decision}`);
        trace.push({ iteration: round + 1, phase: 'evaluating', content: evalCall.decision === 'complete' ? 'COMPLETE' : 'CONTINUE' });

        if (evalCall.decision === 'complete') {
          decision = 'complete';
          break;
        }

        // ---- Context condensing before generating the next task (SC-021). ----
        if (this.ctxManager.shouldCondense()) {
          const condensed = this.ctxManager.condense();
          trace.push({ iteration: round + 1, phase: 'executing_task', content: `context condensed -> ${condensed.summary.length} chars` });
          accumulatedSteps.splice(0, Math.max(0, accumulatedSteps.length - condensed.remainingSteps.length));
        }

        // ---- Replenish the task queue from a fresh interpretation when we run out. ----
        if (round + 1 >= tasks.length) {
          const refined = await generateTasks(this.provider, originalInstruction, interp.interpretation);
          tasks = refined.length > 1 ? refined : [await this.planify(nextGoalHint(originalInstruction, lastOutput))];
        }
      } catch (err) {
        // Any upstream failure during interpretation, planning, execution or evaluation SC-014.
        this.logger.error(`agent loop step failed: ${String(err)}`);
        decision = 'error';
        break;
      }

      // Only count an iteration that ran to completion (executed + evaluated), never one that broke early.
      round++;
    }

    if (decision === 'continue' && !this.sink?.isDisconnected()) {
      decision = 'max_rounds_exceeded';
    }

    const finalResult: FinalResultData = {
      final_output: lastOutput || '',
      iterations_completed: accumulatedSteps.length,
      decision,
      max_rounds: o.max_rounds,
      tasks_executed: accumulatedSteps.map((s) => ({ id: s.task_id ?? `iter-${s.iteration}`, status: 'completed', output: s.output })),
      reasoning_traces_summary: {
        phases_completed: [...this.phaseSet],
        total_upstream_calls: this.totalUpstreamCalls,
        errors_occurred: 0,
      },
      accumulated_context: this.accumulatedSummary(accumulatedSteps),
    };

    if (this.sink) this.sink.emitPhase('completed', { final_output_length: lastOutput.length });
    return { decision, finalResult, trace };
  }

  private resolvedOptions() {
    return {
      max_rounds: this.opts.max_rounds ?? 10, // SC-017
      max_retries: this.opts.max_retries ?? 3, // SC-013
      doom_loop_threshold: this.opts.doom_loop_threshold ?? 4, // SC-012
      context_window_size: this.opts.context_window_size ?? 4096, // SC-022
      model: this.opts.model ?? null,
    };
  }

  private opts = {} as Partial<LoopOptions>;

  private countCall(tag: string): void {
    this.totalUpstreamCalls += 1;
    this.logger.debug(`upstream call (${tag}): total=${this.totalUpstreamCalls}`);
  }

  private emitPhase(phase: Phase, extra?: Record<string, unknown>): void {
    if (this.sink) this.sink.emitPhase(phase, extra);
    this.phaseSet.add(phase);
  }

  private buildContextPrompt(original: string, steps: ContextStep[]): UpstreamMessage[] {
    const history = steps.map((s) => `- iter ${s.iteration}: ${s.output.slice(0, 160)}`).join('\n');
    return [
      { role: 'system', content: `Goal: ${original}` },
      { role: 'user', content: `Progress so far:\n${history || '(none)'}` },
    ];
  }

  private accumulatedSummary(steps: ContextStep[]): string {
    if (!steps.length) return '';
    const parts = steps.map((s, i) => `- iter ${i + 1}: ${s.output.slice(0, 160)}`).join('\n');
    return `Accumulated context:\n${parts}`;
  }

  private async planify(goalHint: string): Promise<AgentTask> {
    const prompt: UpstreamMessage[] = [
      { role: 'system', content: 'You are planning the next concrete, single action to move toward the goal.' },
      { role: 'user', content: `Goal hint:\n${goalHint}\n\nReply EXACTLY with one AgentTask JSON: {"description":"<one clear sentence>"}` },
    ];
    this.countCall('planify');
    const res = await this.provider.complete(this.opts.model ?? null, prompt, {});
    return { id: `task-refine-${Date.now()}`, description: (res.content ?? '').trim(), context_needed: [] };
  }
}

/** A tiny hint used to ask the model for its next best sub-goal. */
function nextGoalHint(original: string, lastOutput: string): string {
  return `The goal is: "${original}". Previous attempt produced roughly: ${(lastOutput || '').slice(0, 240)}`;
}
