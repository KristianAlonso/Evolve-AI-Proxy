// The agent loop orchestrator (the heart of ADR A-003).
// Flow: interpret -> generate task(s) -> execute (with auto-healing + doom-loop guard) ->
// evaluate binary decision -> (context condensing) -> repeat until complete or max_rounds.
// Emits typed SSE events through a LoopSink; results are also returned for the non-stream path.

import type { ChatProvider } from '../provider/types.js';
import { createLogger } from '../logger.js';
import type { Phase, SSEEvent } from '../sse-writer.js';
import type { AgentTask, LoopDecision, TaskResult, ToolCall, ToolChoice, ToolDefinition, UpstreamMessage } from '../types.js';
import { interpretRequest, type Interpretation } from './interpreter.js';
import { generateTasks } from './task-generator.js';
import { evaluateTask } from './evaluator.js';
import { callWithStreaming } from './stream-helper.js';
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
    let pendingToolCalls: ToolCall[] = [];
    let round = 0;

    // FASE 2: the internal loop phases (interpret/planify/evaluate) never see the structured
    // tool-exchange turns that travel on the wire (assistant tool_calls + tool results) — those
    // are wire-protocol artifacts, and re-sending them as provider tool messages can trip
    // provider-specific requirements (e.g. Gemini thought_signatures) on resume. They are rendered
    // as plain text for the internal phases; the structured transcript is injected into the
    // execute prompt instead (see buildExecuteContent / buildToolTranscript).
    const internalMessages = toInternalMessages(messages);

    for (; round < o.max_rounds; round++) {
      try {
        if (this.sink?.isDisconnected()) break; // SC-023: abort before any upstream call

        // ---- Interpret phase (SC-004): ask the model to interpret, surface structured reasoning. ----
        this.phaseSet.add('interpreting');
        this.emitPhase('interpreting', { step: 'interpret' });
        // FASE 1: pass the sink as the live emitter so interpretation reasoning deltas reach the
        // client WHILE the upstream generates them. When the provider streamed, the full-text
        // fallback emit below would duplicate what already left on the wire — skip it then.
        const interp = await interpretRequest(this.provider, [...internalMessages], () => '', { model: o.model }, this.sink);
        if (this.sink && !interp.streamed) this.sink.emitReasoning(0, interp.reasoning || interp.interpretation.mainObjective);

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
            { role: 'user' as const, content: this.buildExecuteContent(task, messages) },
          ];

          // The provider call options carry the delegated client tools (FASE 2); interpretation /
          // planning / evaluation never receive them.
          const callOptions = { tools: o.tools, tool_choice: o.tool_choice };

          // No watcher, or a provider without completeStream (unit-test stubs): fully buffered call.
          if (!this.sink) {
            this.countCall('execute');
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
          this.countCall('execute');

          return { output: (result.content ?? ''), reasoning: result.reasoning || '', doomedLoop: lastDoomed, tool_calls: result.tool_calls };
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

        // ---- Bidirectional tool delegation (FASE 2): the upstream model requested client-side
        // tool calls. We do NOT execute them: surface every call to the client (as OpenAI
        // chat-completion chunks) and pause the loop. The client runs the tools and resumes by
        // re-sending the conversation — assistant tool_calls + tool results — on the same session.
        const delegatedCalls: ToolCall[] = outcome.tool_calls ?? [];
        if (delegatedCalls.length > 0) {
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
        const evalCall = await evaluateTask(this.provider, originalInstruction, this.accumulatedSummary(accumulatedSteps), result, { model: o.model }, this.sink);
        this.countCall('evaluate');
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
    const prompt: UpstreamMessage[] = [
      { role: 'system', content: 'You are planning the next concrete, single action to move toward the goal.' },
      { role: 'user', content: `Goal hint:\n${goalHint}\n\nReply EXACTLY with one AgentTask JSON: {"description":"<one clear sentence>"}` },
    ];
    this.countCall('planify');
    // FASE 1: planning reasoning also streams live to a watching client. The task-description JSON
    // is internal — only the thinking path is surfaced (same rule as interpretation/evaluation).
    const { result } = await callWithStreaming({
      provider: this.provider,
      model: this.opts.model ?? null,
      messages: prompt,
      options: {},
      surfaceDelta: this.sink
        ? (chunk) => {
            const reasoning = typeof chunk.reasoning === 'string' ? chunk.reasoning : '';
            if (reasoning !== '') this.sink?.emitReasoningDelta(0, reasoning);
          }
        : undefined,
    });
    return { id: `task-refine-${Date.now()}`, description: (result.content ?? '').trim(), context_needed: [] };
  }
}

/** A tiny hint used to ask the model for its next best sub-goal. */
function nextGoalHint(original: string, lastOutput: string): string {
  return `The goal is: "${original}". Previous attempt produced roughly: ${(lastOutput || '').slice(0, 240)}`;
}

/**
 * Sanitize the incoming wire conversation for the internal loop phases (FASE 2): assistant
 * tool_call turns and tool-result turns are collected and rendered as a single plain-text USER
 * turn. Reasons:
 *   1. The interpret/planify/evaluate prompts never carry structured tool parts (providers with
 *      opaque per-provider requirements like Gemini thought_signatures must not see them).
 *   2. The rendered turn is `role: user` — Vertex-backed models reject requests whose final
 *      message is an assistant/model turn.
 */
function toInternalMessages(messages: UpstreamMessage[]): UpstreamMessage[] {
  const out: UpstreamMessage[] = [];
  let exchange: string[] = [];
  const flushExchange = (out: UpstreamMessage[]): void => {
    if (exchange.length > 0) {
      out.push({ role: 'user', content: `Tool exchange (already performed by the client):\n${exchange.join('\n')}` });
      exchange = [];
    }
  };
  for (const message of messages) {
    if (message.role === 'tool') {
      exchange.push(`tool result for ${message.tool_call_id ?? ''}: ${message.content ?? ''}`);
      continue;
    }
    if (message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0) {
      for (const call of message.tool_calls) {
        exchange.push(`assistant tool_call ${call.id}: ${call.function.name}(${call.function.arguments})`);
      }
      if (message.content) exchange.push(`assistant: ${message.content}`);
      continue;
    }
    flushExchange(out);
    out.push(message);
  }
  flushExchange(out);
  return out;
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
