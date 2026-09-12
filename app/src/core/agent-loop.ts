// The agent loop orchestrator (the heart of ADR A-003).
// Flow: interpret -> generate task(s) -> execute (with auto-healing + doom-loop guard) ->
// evaluate binary decision -> (context condensing) -> repeat until complete or max_rounds.
// Emits typed SSE events through a LoopSink; results are also returned for the non-stream path.

import { isAbortError } from '../provider/types.js';
import type { ChatProvider } from '../provider/types.js';
import { createLogger, type TraceLogger } from '../logger.js';
import type { Phase, SSEEvent } from '../sse-writer.js';
import type { AgentTask, LoopDecision, TaskResult, ToolCall, ToolChoice, ToolDefinition, UpstreamMessage } from '../types.js';
import { interpretRequest, type Interpretation } from './interpreter.js';
import { generateTasks } from './task-generator.js';
import { evaluateTask } from './evaluator.js';
import { callWithStreaming } from './stream-helper.js';
import { withAutoHealingRetry } from '../safety/auto-healing-retry.js';
import { ContextManager, type ContextStep } from './context-manager.js';
import { detectDoomLoop, type DoomLoopResult } from '../safety/doom-loop-detector.js';
import {
  buildPlanifyPrompt,
  buildRenderedExecutePrompt,
  buildStructuredExecutePrompt,
  goalHintForPlanify,
  isStructuredRejection,
  toInternalMessages,
  toRenderedMessages,
} from './phase-prompts.js';

/** Minimal sink the orchestrator writes to. Structurally satisfied by SseWriter AND a test sink. */
export interface LoopSink {
  isDisconnected(): boolean;
  emitReasoning(iteration: number, text: string): void;
  /** Emit one live reasoning delta during streaming mode (SC-012). */
  emitReasoningDelta(iteration: number, delta: string): void;
  /** Emit one live assistant-text delta as an OpenAI chat-completion.chunk during streaming (dual path). */
  emitContent(_iteration: number, _text: string): void;
  /** Emit delegated tool calls as OpenAI chat-completion.chunk frames (FASE 2). */
  emitToolCalls(calls: ToolCall[]): void;
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
  /** Client-side tools to delegate (FASE 2). Only the execute step sees them — interpretation,
   *  planning and evaluation keep their internal structured prompts tool-free. */
  tools?: ToolDefinition[];
  tool_choice?: ToolChoice;
  /** Traced request logger (routes passes one bound to the request's trace id). Falls back to a
   *  session-only logger when absent (tests, in-process use). */
  logger?: TraceLogger;
  /** Raw trace id of the originating HTTP request (for upstream request/response captures). */
  traceId?: string;
  /**
   * Abort signal for the whole run (stop propagation, SC-023): when the client interrupts the
   * connection or asks the model to stop, the routes layer aborts it — every in-flight upstream
   * call is cancelled and the loop breaks at the next checkpoint without wasting retries.
   */
  abort_signal?: AbortSignal;
  /**
   * ADR A-007 (passthrough-intacto): the client request's body fields, verbatim (minus
   * messages/model/stream/tools/tool_choice and the evolve controls). Every upstream call the loop
   * makes forwards them so the model sees the SAME request shape the client sent.
   */
  passthrough?: Record<string, unknown>;
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
  /** Tool calls delegated to the client when the decision is 'tool_calls_pending' (FASE 2). */
  tool_calls: ToolCall[];
}

/** One self-contained execution attempt inside the auto-healing wrapper. */
type ExecStep = () => Promise<{
  output: string;
  reasoning: string;
  doomedLoop: DoomLoopResult;
  tool_calls: ToolCall[];
}>;

export class AgentLoop {
  private provider: ChatProvider;
  private sink?: LoopSink;
  private logger: TraceLogger;
  /** R1 (FASE 6): sticky after a 4xx rejection of the structured assistant history — every later
   *  phase of this run uses the rendered (flat) conversation/prompt shape. */
  private fellBackToRendered = false;
  private ctxManager = new ContextManager(4096);
  private phaseSet = new Set<Phase>();
  /** Live upstream-call counter (SC-018). */
  totalUpstreamCalls = 0;

  constructor(provider: ChatProvider, sink?: LoopSink, opts: Partial<LoopOptions> = {}) {
    this.provider = provider;
    this.sink = sink;
    this.opts = opts;
    this.ctxManager.setWindowSize(opts.context_window_size ?? 4096);
    this.logger = opts.logger ?? createLogger('loop');
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
    let pendingToolCalls: ToolCall[] = [];
    let round = 0;
    const startedAt = Date.now();

    this.logger.info(
      `agent loop start: model=${o.model ?? 'auto'} max_rounds=${o.max_rounds} messages=${messages.length} ` +
      `tools=${o.tools?.length ? o.tools.map((t) => t.function.name).join(',') : '-'} ` +
      `tool_choice=${o.tool_choice ?? '-'} resume=${buildToolTranscript(messages).length > 0}`,
    );

    // R1 (FASE 6): assistant turns (including the client's tool_call/tool-result exchange) travel
    // to the model as REAL assistant/tool turns — the model's own history is its own history. For
    // upstreams that reject that shape (4xx, e.g. Vertex thought_signatures) we retry ONCE with
    // the rendered (flat) version and stay on it for the rest of the run (fellBackToRendered).
    const structuredInternal = toInternalMessages(messages);
    const renderedInternal = toRenderedMessages(messages);

    for (; round < o.max_rounds; round++) {
      try {
        // SC-023: abort before any upstream call when the sink is already gone.
        if (this.sink?.isDisconnected()) break;
        // Stop propagation: an aborted request (the user cut the connection / asked the model to
        // stop) halts the loop before any further upstream call; the in-flight call, if any, is
        // cancelled through the same AbortSignal. Unlike a silent sink disconnect this is an
        // explicit failure of the run, so it records decision='error'.
        if (o.abort_signal?.aborted) {
          if (decision === 'continue') decision = 'error';
          this.logger.warn(`agent loop stopped: client aborted (round ${round + 1})`);
          break;
        }

        // ---- Interpret phase (SC-004): ask the model to interpret, surface structured reasoning. ----
        this.phaseSet.add('interpreting');
        this.emitPhase('interpreting', { step: 'interpret' });
        // FASE 1: pass the sink as the live emitter so interpretation reasoning deltas reach the
        // client WHILE the upstream generates them. When the provider streamed, the full-text
        // fallback emit below would duplicate what already left on the wire — skip it then.
        const interpT0 = Date.now();
        this.countCall('interpret');
        let interp;
        try {
          interp = await interpretRequest(this.provider, this.fellBackToRendered ? [...renderedInternal] : [...structuredInternal], () => '', { model: o.model, logger: this.logger, traceId: o.traceId, abort_signal: o.abort_signal, passthrough: o.passthrough }, this.sink);
        } catch (err) {
          if (!this.fellBackToRendered && isStructuredRejection(err) && !isAbortError(err) && !o.abort_signal?.aborted) {
            this.fellBackToRendered = true;
            this.logger.warn('interpret: upstream rejected structured conversation — retrying with rendered (flat) conversation');
            interp = await interpretRequest(this.provider, [...renderedInternal], () => '', { model: o.model, logger: this.logger, traceId: o.traceId, abort_signal: o.abort_signal, passthrough: o.passthrough }, this.sink);
          } else {
            throw err;
          }
        }
        if (this.sink && !interp.streamed) this.sink.emitReasoning(0, interp.reasoning || interp.interpretation.mainObjective);
        this.logger.info(
          `interpret (round ${round + 1}): ${Date.now() - interpT0}ms objective="${interp.interpretation.mainObjective.replace(/\s+/g, ' ').slice(0, 160)}" ` +
          `sub_objectives=${interp.interpretation.subObjectives.length} resources=${interp.interpretation.resourcesNeeded.length}`,
        );

        // ---- Initial task generation from the interpretation (SC-005). ----
        let tasks = await generateTasks(this.provider, originalInstruction, interp.interpretation);

        // ---- Planning / task selection. Consume pre-generated tasks in order, refine when out. ----
        this.emitPhase('planning', { step: 'planify' });
        const planT0 = Date.now();
        const task = tasks[round] ?? await this.planify(goalHintForPlanify(originalInstruction, lastOutput));
        this.logger.info(`plan (round ${round + 1}): ${Date.now() - planT0}ms task="${task.description.replace(/\s+/g, ' ').slice(0, 160)}"`);
        trace.push({ iteration: round + 1, phase: 'planning', task_id: task.id, content: task.description });

        // ---- Execute with auto-healing + doom-loop guard (SC-012/013/014). ----
        this.emitPhase('executing_task', { step: `execute #${round + 1}` });
        // R1 (FASE 6): previous step outputs ride as real assistant turns (structured prompt);
        // the rendered (flat) shape is the 4xx fallback. Both share the same task content.
        const taskContent = this.buildExecuteContent(task, messages);
        const structuredPrompt = buildStructuredExecutePrompt(originalInstruction, accumulatedSteps, taskContent);
        const renderedPrompt = buildRenderedExecutePrompt(originalInstruction, accumulatedSteps, taskContent);
        const makeExecuteStep = (prompt: UpstreamMessage[]): ExecStep => async () => {
          // The provider call options carry the delegated client tools (FASE 2); interpretation /
          // planning / evaluation never receive them.
          const callOptions = { tools: o.tools, tool_choice: o.tool_choice, logger: this.logger, trace_id: o.traceId, abort_signal: o.abort_signal, passthrough: o.passthrough };

          // Counted BEFORE the call: a failed upstream call is still an upstream call — the metric
          // must reflect what left the proxy (the deterministic-error path threw before the old
          // post-call count, so failures were invisible in `request done`).
          this.countCall('execute');

          // No watcher, or a provider without completeStream (unit-test stubs): fully buffered call.
          if (!this.sink) {
            const res = await this.provider.complete(o.model, prompt, callOptions);
            return { output: res.content ?? '', reasoning: res.reasoning || '', doomedLoop: { detected: false, repetitions: 0 }, tool_calls: res.tool_calls };
          }

          // ---- Streaming attempt: stream live thinking + detect a runaway while it generates. ----
          // callWithStreaming invokes completeStream WITH the provider as its receiver — a detached
          // reference (`const f = this.provider.completeStream; f(...)`) loses `this` and the SDK
          // client lookup throws (see the warning in stream-helper.ts). It also accumulates the full
          // body for us, so the returned result is parseable like a buffered complete() call.
          let acc = '';
          let lastDoomed: DoomLoopResult = { detected: false, repetitions: 0 };

          const { result } = await callWithStreaming({
            provider: this.provider,
            model: o.model,
            messages: prompt,
            options: callOptions,
            surfaceDelta: (chunk) => {
              const reasoning = typeof chunk.reasoning === 'string' ? chunk.reasoning : '';
              const content = typeof chunk.content === 'string' ? chunk.content : '';

              // Live reasoning trace to the client — incremental per arriving delta.
              if (reasoning !== '') this.sink?.emitReasoningDelta(round + 1, reasoning);
              // Surface live assistant text so the OpenAI client reconstructs the answer as it arrives.
              if (content !== '') this.sink?.emitContent(round + 1, content);

              // Detect a doom-loop mid-generation so a runaway is visible while the model still
              // generates. detectDoomLoop is the same pure function used post-hoc by the retry guard.
              acc += reasoning + content;
              const doomed = detectDoomLoop(acc, o.doom_loop_threshold);
              if (doomed.detected) lastDoomed = doomed;
            },
          });

          return { output: (result.content ?? ''), reasoning: result.reasoning || '', doomedLoop: lastDoomed, tool_calls: result.tool_calls };
        };

        let outcome;
        const execT0 = Date.now();
        try {
          outcome = await this.runExecuteWithFallback(makeExecuteStep, structuredPrompt, renderedPrompt, round, o);
        } catch (err) {
          if (isAbortError(err) || o.abort_signal?.aborted) {
            this.logger.warn(`execute aborted (round ${round + 1}): ${Date.now() - execT0}ms — stopped per client request`);
          } else {
            this.logger.error(`execute failed (round ${round + 1}): ${Date.now() - execT0}ms: ${String(err)}`);
          }
          decision = 'error';
          break;
        }
        this.logger.info(
          `execute (round ${round + 1}): ${Date.now() - execT0}ms status=${outcome.result.status} ` +
          `output_len=${outcome.result.output.length} heal_retries=${outcome.traces.length} ` +
          `doom_loop=${outcome.doomedLoop.detected}`,
        );

        const result: TaskResult = outcome.result;
        if (result.status === 'failed') {
          const aborted =
            o.abort_signal?.aborted === true ||
            (result.error !== undefined && isAbortError({ message: result.error }));
          if (aborted) {
            // The client interrupted (disconnect or explicit stop): no refusal, no doom loop —
            // just stop, and never retry an aborted upstream call.
            this.logger.warn(`execute aborted (round ${round + 1}): stopped per client request (no retry)`);
            decision = 'error';
          } else {
            decision = 'refusal_exhausted';
          }
          trace.push({ iteration: round + 1, phase: 'error', content: result.error ?? 'step failed after retries' });
          break;
        }

        // ---- Bidirectional tool delegation (FASE 2): the upstream model requested client-side
        // tool calls. We do NOT execute them: surface every call to the client (as OpenAI
        // chat-completion chunks) and pause the loop. The client runs the tools and resumes by
        // re-sending the conversation — assistant tool_calls + tool results — on the same session.
        const delegatedCalls: ToolCall[] = outcome.tool_calls ?? [];
        if (delegatedCalls.length > 0) {
          this.logger.info(
            `delegating ${delegatedCalls.length} tool call(s) to client: ` +
            delegatedCalls.map((c) => `${c.function.name}(${(c.function.arguments ?? '').replace(/\s+/g, ' ').slice(0, 120)})`).join('; ')
        );
          this.sink?.emitToolCalls(delegatedCalls);
          decision = 'tool_calls_pending';
          pendingToolCalls = delegatedCalls;
          trace.push({
            iteration: round + 1,
            phase: 'executing_task',
            content: `delegating ${delegatedCalls.length} tool call(s) to the client: ${delegatedCalls.map((c) => c.function.name).join(', ')}`,
          });
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
        // FASE 1: stream the evaluator's reasoning live too; on the buffered path keep the previous
        // whole-text emit so no tracing is lost when the provider cannot stream.
        const evalT0 = Date.now();
        this.countCall('evaluate');
        const evalCall = await evaluateTask(this.provider, originalInstruction, this.accumulatedSummary(accumulatedSteps), result, { model: o.model, logger: this.logger, traceId: o.traceId, abort_signal: o.abort_signal, passthrough: o.passthrough }, this.sink);
        this.logger.info(`evaluate (round ${round + 1}): ${Date.now() - evalT0}ms decision=${evalCall.decision}`);
        if (this.sink) {
          if (evalCall.streamed) {
            // The "why" already arrived as live deltas; only append the binary decision marker.
            this.sink.emitReasoningDelta(round + 1, ` -> ${evalCall.decision}`);
          } else {
            this.sink.emitReasoning(round + 1, `${evalCall.reasoning}\n-> ${evalCall.decision}`);
          }
        }
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
          this.logger.info(`context condensed (round ${round + 1}): kept ${condensed.remainingSteps.length} steps, summary ${condensed.summary.length} chars`);
        }

        // ---- Replenish the task queue from a fresh interpretation when we run out. ----
        if (round + 1 >= tasks.length) {
          const refined = await generateTasks(this.provider, originalInstruction, interp.interpretation);
          tasks = refined.length > 1 ? refined : [await this.planify(goalHintForPlanify(originalInstruction, lastOutput))];
        }
      } catch (err) {
        // Any upstream failure during interpretation, planning, execution or evaluation SC-014.
        if (isAbortError(err) || o.abort_signal?.aborted) {
          this.logger.warn(`agent loop aborted (round ${round + 1}): ${String(err)} — stopping per client request (no retry)`);
        } else {
          this.logger.error(`agent loop step failed (round ${round + 1}): ${String(err)}`);
        }
        decision = 'error';
        break;
      }

      // Only count an iteration that ran to completion (executed + evaluated), never one that broke early.
      round++;
    }

    if (decision === 'continue' && !this.sink?.isDisconnected()) {
      decision = 'max_rounds_exceeded';
    }
    this.logger.info(
      `agent loop end: decision=${decision} rounds=${round + (decision === 'max_rounds_exceeded' ? 0 : 0)} ` +
      `upstream_calls=${this.totalUpstreamCalls} output_len=${lastOutput.length} elapsed=${Date.now() - startedAt}ms`,
    );

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
      tool_calls: pendingToolCalls,
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
      tools: this.opts.tools,
      tool_choice: this.opts.tool_choice,
      traceId: this.opts.traceId,
      abort_signal: this.opts.abort_signal,
      passthrough: this.opts.passthrough,
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

  /**
   * Build the execute user turn (FASE 2): the task, plus — when client tools are in play — the
   * instructions that tools exist, and the transcript of the tool exchange already performed by
   * the client (assistant tool_calls + tool results re-sent in the incoming conversation) so a
   * resumed run continues from where the delegation paused.
   */
  private buildExecuteContent(task: AgentTask, incoming: UpstreamMessage[]): string {
    const parts: string[] = [task.description];
    if (this.opts.tools && this.opts.tools.length > 0) {
      parts.push(
        [
          'Client-side tools are available to you. If a tool is required to accomplish the task,',
          'emit the tool call instead of plain text: the client executes it and returns the',
          'result. Reply with plain text only when the task is complete.',
        ].join(' '),
      );
    }
    const transcript = buildToolTranscript(incoming);
    if (transcript) {
      parts.push(`Tool exchange already performed by the client (keep using these results):\n${transcript}`);
    }
    return parts.join('\n\n');
  }

  private accumulatedSummary(steps: ContextStep[]): string {
    if (!steps.length) return '';
    const parts = steps.map((s, i) => `- iter ${i + 1}: ${s.output.slice(0, 160)}`).join('\n');
    return `Accumulated context:\n${parts}`;
  }

  private async planify(goalHint: string): Promise<AgentTask> {
    const prompt = buildPlanifyPrompt(goalHint);
    this.countCall('planify');
    // FASE 1: planning reasoning also streams live to a watching client. The task-description JSON
    // is internal — only the thinking path is surfaced (same rule as interpretation/evaluation).
    const { result } = await callWithStreaming({
      provider: this.provider,
      model: this.opts.model ?? null,
      messages: prompt,
      options: { logger: this.logger, trace_id: this.opts.traceId, abort_signal: this.opts.abort_signal, passthrough: this.opts.passthrough },
      surfaceDelta: this.sink
        ? (chunk) => {
            const reasoning = typeof chunk.reasoning === 'string' ? chunk.reasoning : '';
            if (reasoning !== '') this.sink?.emitReasoningDelta(0, reasoning);
          }
        : undefined,
    });
    return { id: `task-refine-${Date.now()}`, description: (result.content ?? '').trim(), context_needed: [] };
  }

  /**
   * R1 (FASE 6): run the execute step against the STRUCTURED prompt (previous outputs as real
   * assistant turns); if the upstream rejects that conversation shape (4xx), retry ONCE with the
   * rendered (flat) prompt and stay on it (sticky). Aborts and non-structured errors propagate
   * untouched (the outer loop handles them).
   */
  private async runExecuteWithFallback(
    makeExecuteStep: (prompt: UpstreamMessage[]) => ExecStep,
    structured: UpstreamMessage[],
    rendered: UpstreamMessage[],
    round: number,
    o: ReturnType<AgentLoop['resolvedOptions']>,
  ) {
    const retryOpts = { maxRetries: o.max_retries, doomLoopThreshold: o.doom_loop_threshold, abortSignal: o.abort_signal };
    try {
      return await withAutoHealingRetry(makeExecuteStep(structured), retryOpts);
    } catch (err) {
      if (this.fellBackToRendered || isAbortError(err) || o.abort_signal?.aborted || !isStructuredRejection(err)) {
        throw err;
      }
      this.fellBackToRendered = true;
      this.logger.warn(`execute (round ${round + 1}): upstream rejected structured assistant history — retrying with rendered (flat) prompt`);
      return await withAutoHealingRetry(makeExecuteStep(rendered), retryOpts);
    }
  }
}

/**
 * Render the tool exchange already present in the incoming conversation (FASE 2 resume): assistant
 * tool_call turns followed by the client's tool results. Empty when the conversation has none.
 */
function buildToolTranscript(messages: UpstreamMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0) {
      for (const call of message.tool_calls) {
        lines.push(`assistant tool_call ${call.id}: ${call.function.name}(${call.function.arguments})`);
      }
    } else if (message.role === 'tool') {
      lines.push(`tool result for ${message.tool_call_id ?? ''}: ${message.content ?? ''}`);
    }
  }
  return lines.join('\n');
}
