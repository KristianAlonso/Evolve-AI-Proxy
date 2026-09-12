// FASE 6 — subagent phase delegation (R3). The agent loop becomes resumable across independent
// HTTP requests:
//
//   1) PARENT FIRST REQUEST (tools present):
//        (0) mapping call  -> SubagentSpawnSpec (which client tool creates subagents + arg map)
//        (1) interpret     -> the ONLY phase that runs in the parent (its reasoning streams out)
//        (2) emit the spawn ToolCall for `planify` and pause (decision: tool_calls_pending)
//
//   2) SUBAGENT REQUEST (the client opened the subagent after the spawn tool call): its prompt
//      carries the envelope JSON (line 1) -> the proxy runs that ONE phase from the parent's
//      stored loop state and returns the phase output as the subagent's assistant content.
//
//   3) PARENT RESUME REQUEST: the proxy consumes the stored phase result (keyed by agent_id),
//      advances the stage machine (planify -> execute -> evaluate -> [next round] | done) and
//      emits the next spawn ToolCall or the final answer.
//
// The `agent_id` is minted by the proxy before the ToolCall and travels ONLY inside the envelope
// prompt — never as a tool argument. The canonical phase result is the subagent's LAST content
// (a subagent may make several internal LLM calls; its follow-up requests update the same entry).
//
// Fail-safe: when the mapping finds no subagent-spawn tool (or the model cannot map it), `start`
// returns null and the caller degrades to the classic inline AgentLoop — no request ever breaks.

import type { ChatProvider } from '../provider/types.js';
import type { TraceLogger } from '../logger.js';
import env from '../config.js';
import type { LoopDecision, TaskResult, ToolCall, ToolChoice, ToolDefinition, UpstreamMessage } from '../types.js';
import { mapSubagentTool } from './subagent-mapper.js';
import { interpretRequest } from './interpreter.js';
import { buildEvaluatePrompt, classifyEvaluation } from './evaluator.js';
import { callWithStreaming } from './stream-helper.js';
import {
  accumulatedSummary,
  buildPlanifyPrompt,
  buildRenderedExecutePrompt,
  buildStructuredExecutePrompt,
  goalHintForPlanify,
  isStructuredRejection,
  stepBullets,
} from './phase-prompts.js';
import { buildSpawnToolCall, newAgentId, type DelegatedPhase } from './subagent-spawn.js';
import type { LoopStateData } from './loop-state.js';
import type { LoopSink } from './agent-loop.js';

/**
 * How many consecutive spawn re-emissions of the SAME pending phase (without any phase result
 * arriving) are tolerated before the orchestrator rotates to the next available subagent type
 * from `spec.availableTypes` (failover). The type that finally yields a phase result is pinned
 * for the rest of the session. Configurable via the `SPAWN_RETRY_THRESHOLD` env var (default 3).
 */
export const SPAWN_RETRY_THRESHOLD: number = env.SPAWN_RETRY_THRESHOLD;

/** One delegated subagent: its agent_id + the phase it is running. */
export interface SubagentBinding {
  agentId: string;
  phase: DelegatedPhase;
}

/** What a parent-facing orchestrator outcome carries to the routes layer. */
export interface OrchestratorOutcome {
  /** 'tool_call' = the parent must call the spawn tool (stream/JSON carries the ToolCall).
   *  'final' = the loop is over; `finalOutput` is the client's answer. */
  kind: 'tool_call' | 'final';
  toolCall?: ToolCall;
  decision: LoopDecision;
  finalOutput: string;
}

export class SubagentOrchestrator {
  constructor(private provider: ChatProvider, private logger: TraceLogger) {}

  /**
   * First parent request with client tools: mapping + interpret, then emit the spawn ToolCall for
   * `planify`. Returns null when the mapping yields no usable spec -> the caller degrades to the
   * inline AgentLoop.
   *
   * `makeSink` is a FACTORY (not a sink) because creating the SSE writer has side effects (it
   * writes the `: connected` comment frame); the factory is only invoked AFTER a successful
   * mapping, so a failed mapping leaves the socket untouched for the inline fallback.
   */
  async start(args: {
    state: LoopStateData;
    sessionId: string;
    model: string;
    makeSink?: () => LoopSink | undefined;
    traceId?: string;
    abort_signal?: AbortSignal;
  }): Promise<{ outcome: OrchestratorOutcome; sink?: LoopSink } | null> {
    const { state, sessionId, model } = args;

    const spec = await mapSubagentTool(this.provider, state.tools ?? [], {
      model,
      logger: this.logger,
      traceId: args.traceId,
      abort_signal: args.abort_signal,
    });
    if (!spec) return null;
    state.spec = spec;
    state.activeTypeId = spec.typeId;
    state.spawnRetries = 0;
    state.totalUpstreamCalls += 1; // the mapping call itself

    // Interpret is the only phase that runs in the parent (R3). Its reasoning streams to the
    // client (R2); the structured JSON stays internal.
    const t0 = Date.now();
    const sink = args.makeSink?.();
    const { interpretation } = await interpretRequest(
      this.provider,
      state.internalMessages,
      () => '',
      { model, logger: this.logger, traceId: args.traceId, abort_signal: args.abort_signal },
      sink,
    );
    state.totalUpstreamCalls += 1;
    state.interpretation = interpretation;
    state.stage = 'planify';
    this.logger.info(
      `orchestrator start: interpret ${Date.now() - t0}ms objective="${interpretation.mainObjective.replace(/\s+/g, ' ').slice(0, 160)}"`,
    );

    return {
      outcome: { kind: 'tool_call', toolCall: this.emitSpawn(state, sessionId), decision: 'tool_calls_pending', finalOutput: '' },
      sink,
    };
  }

  /**
   * Parent resume: consume the stored phase result, advance the stage machine, then either emit
   * the next spawn ToolCall or deliver the final answer. Synchronous — no upstream call happens
   * here (the phase already ran in the subagent's request).
   */
  resume(state: LoopStateData, sessionId: string): OrchestratorOutcome {
    if (state.stage !== 'done') {
      const agentId = state.pendingAgentId;
      const phaseResult = agentId ? state.phaseResults[agentId] : undefined;
      if (agentId && phaseResult === undefined) {
        // The subagent's phase result has not arrived yet (the client has not run the subagent —
        // e.g. its plugin blocked the dispatch). Re-emit the SAME spawn (same agent_id) WITHOUT
        // consuming the stage; rounds only advance once the parent holds a real phase result, so
        // a blocked/missing subagent can never spin the loop with empty output.
        //
        // FAILOVER: after SPAWN_RETRY_THRESHOLD re-emissions with no result, the active subagent
        // type is considered broken — rotate to the next available type (most general first) and
        // re-dispatch with a FRESH agent id. The type that finally yields a result is pinned.
        state.spawnRetries += 1;
        if (state.spawnRetries >= SPAWN_RETRY_THRESHOLD) {
          const nextType = this.nextFailoverType(state);
          if (nextType) {
            this.logger.warn(
              `orchestrator failover: type="${state.activeTypeId}" never produced a phase result after ${state.spawnRetries - 1} re-emits — ` +
              `retrying with type="${nextType}" (stage=${state.stage} round=${state.round})`,
            );
            state.activeTypeId = nextType;
            state.spawnRetries = 0;
            return {
              kind: 'tool_call',
              toolCall: this.emitSpawn(state, sessionId),
              decision: 'tool_calls_pending',
              finalOutput: '',
            };
          }
        }
        this.logger.info(
          `orchestrator resume: no phase result yet for agent_id=${agentId} (retries=${state.spawnRetries}/${SPAWN_RETRY_THRESHOLD}) — re-emitting spawn (stage=${state.stage} round=${state.round})`,
        );
        return {
          kind: 'tool_call',
          toolCall: this.emitSpawn(state, sessionId, agentId),
          decision: 'tool_calls_pending',
          finalOutput: '',
        };
      }
      if (!agentId) {
        this.logger.warn('orchestrator resume: no pending agent id — phase result missing (TTL eviction?), skipping consumption');
      } else {
        switch (state.stage) {
          case 'planify': {
            state.task = {
              id: `task-r${state.round}`,
              description: parsePhaseTask(phaseResult ?? ''),
              context_needed: [],
            };
            state.stage = 'execute';
            break;
          }
          case 'execute': {
            const output = (phaseResult ?? '').trim() || '(no output)';
            state.lastOutput = output;
            state.accumulatedSteps.push({
              iteration: state.round,
              objective: state.interpretation?.mainObjective,
              task_id: state.task?.id,
              output,
              successful: true,
            });
            state.stage = 'evaluate';
            break;
          }
          case 'evaluate': {
            const decision = classifyEvaluation(phaseResult ?? '').decision;
            if (decision === 'complete') {
              state.decision = 'complete';
              state.stage = 'done';
              state.finalOutput = state.lastOutput;
            } else if (state.round >= state.max_rounds) {
              state.decision = 'max_rounds_exceeded';
              state.stage = 'done';
              state.finalOutput = state.lastOutput;
            } else {
              state.round += 1;
              state.stage = 'planify';
            }
            break;
          }
          default:
            break;
        }
        delete state.phaseResults[agentId];
        state.pendingAgentId = null;
        state.spawnRetries = 0; // a real result arrived: keep the current type (pinned for the session)
      }
    }

    if (state.stage === 'done') {
      this.logger.info(
        `orchestrator done: decision=${state.decision} round=${state.round} upstream_calls=${state.totalUpstreamCalls} output_len=${state.finalOutput.length}`,
      );
      return { kind: 'final', decision: state.decision ?? 'complete', finalOutput: state.finalOutput };
    }
    return { kind: 'tool_call', toolCall: this.emitSpawn(state, sessionId), decision: 'tool_calls_pending', finalOutput: '' };
  }

  /**
   * Run ONE delegated phase for the subagent's first request. The phase output is what the
   * subagent's client receives as assistant content (R2: content = the actual answer, reasoning =
   * live thinking). The parent consumes it later from `state.phaseResults[agent_id]`.
   */
  async runSubagentPhase(args: {
    state: LoopStateData;
    binding: SubagentBinding;
    model: string;
    tools?: ToolDefinition[];
    tool_choice?: ToolChoice;
    sink?: LoopSink;
    traceId?: string;
    abort_signal?: AbortSignal;
  }): Promise<{ content: string; reasoning: string }> {
    const { state, binding, model } = args;
    const { agentId, phase } = binding;
    const t0 = Date.now();

    let prompt: UpstreamMessage[];
    switch (phase) {
      case 'planify':
        prompt = buildPlanifyPrompt(goalHintForPlanify(state.originalInstruction, state.lastOutput));
        break;
      case 'execute': {
        const task = state.task?.description ?? state.originalInstruction;
        prompt = buildStructuredExecutePrompt(state.originalInstruction, state.accumulatedSteps, task);
        break;
      }
      case 'evaluate': {
        const taskResult: TaskResult = {
          id: state.task?.id ?? `task-r${state.round}`,
          status: 'completed',
          output: state.lastOutput,
          reasoning: '',
          attempts: 1,
        };
        prompt = buildEvaluatePrompt(state.originalInstruction, accumulatedSummary(state.accumulatedSteps), taskResult);
        break;
      }
      default:
        throw new Error(`unknown delegated phase: ${phase}`);
    }

    let result;
    if (phase === 'execute') {
      // R1: structured assistant history first; if the upstream rejects the shape (4xx), retry ONCE
      // with the rendered (flat) prompt.
      const runWith = async (p: UpstreamMessage[]) => {
        const out = await callWithStreaming({
          provider: this.provider,
          model,
          messages: p,
          options: {
            tools: args.tools,
            tool_choice: args.tool_choice,
            logger: this.logger,
            trace_id: args.traceId,
            abort_signal: args.abort_signal,
          },
          surfaceDelta: args.sink
            ? (chunk) => {
                const reasoning = typeof chunk.reasoning === 'string' ? chunk.reasoning : '';
                const content = typeof chunk.content === 'string' ? chunk.content : '';
                if (reasoning !== '') args.sink?.emitReasoningDelta(0, reasoning);
                if (content !== '') args.sink?.emitContent(0, content);
              }
            : undefined,
        });
        return out.result;
      };
      try {
        result = await runWith(prompt);
      } catch (err) {
        if (isStructuredRejection(err)) {
          this.logger.warn(`subagent execute: upstream rejected structured assistant history — retrying rendered (agent_id=${agentId})`);
          result = await runWith(buildRenderedExecutePrompt(state.originalInstruction, state.accumulatedSteps, state.task?.description ?? state.originalInstruction));
        } else {
          throw err;
        }
      }
    } else {
      const out = await callWithStreaming({
        provider: this.provider,
        model,
        messages: prompt,
        options: { logger: this.logger, trace_id: args.traceId, abort_signal: args.abort_signal },
        surfaceDelta: args.sink
          ? (chunk) => {
              const reasoning = typeof chunk.reasoning === 'string' ? chunk.reasoning : '';
              const content = typeof chunk.content === 'string' ? chunk.content : '';
              if (reasoning !== '') args.sink?.emitReasoningDelta(0, reasoning);
              if (content !== '') args.sink?.emitContent(0, content);
            }
          : undefined,
      });
      result = out.result;
    }

    state.phaseResults[agentId] = result.content ?? '';
    state.totalUpstreamCalls += 1;
    this.logger.info(
      `subagent phase: phase=${phase} agent_id=${agentId} ${Date.now() - t0}ms output_len=${(result.content ?? '').length}`,
    );
    return { content: result.content ?? '', reasoning: result.reasoning ?? '' };
  }

  /** Mint the agent id, build the envelope + prompt and return the spawn ToolCall (R3).
   *  `reuseAgentId` re-emits an already-minted spawn (parent resume with the phase result
   *  still missing) — the same agent id, the same envelope. */
  private emitSpawn(state: LoopStateData, sessionId: string, reuseAgentId?: string): ToolCall {
    const spec = state.spec;
    if (!spec) throw new Error('cannot emit spawn: no subagent spawn spec (mapping failed)');
    const agentId = reuseAgentId ?? newAgentId();
    const envelope = {
      phase: state.stage as DelegatedPhase,
      parent_session_id: sessionId,
      agent_id: agentId,
    };
    const toolCall = buildSpawnToolCall(spec, envelope, this.spawnTaskDescription(state), `${envelope.phase} (round ${state.round})`, state.activeTypeId);
    state.pendingAgentId = agentId;
    this.logger.info(
      `orchestrator spawn: phase=${envelope.phase} round=${state.round} agent_id=${agentId} tool=${spec.toolName} type=${state.activeTypeId || spec.typeId}`,
    );
    return toolCall;
  }

  /**
   * Failover: the next available subagent type (ordered most general-purpose first). Null when
   * the current type is already the last one — in that case the orchestrator keeps re-emitting
   * the same spawn forever (stable, no further rotation possible).
   */
  private nextFailoverType(state: LoopStateData): string | null {
    const types = state.spec?.availableTypes ?? [];
    const idx = types.findIndex((t) => t.id === state.activeTypeId);
    if (idx >= 0 && idx + 1 < types.length) return types[idx + 1].id;
    return null;
  }

  /** The "current task" description that rides in the spawn prompt (after the envelope line). */
  private spawnTaskDescription(state: LoopStateData): string {
    switch (state.stage) {
      case 'planify':
        return [
          `Goal: "${state.originalInstruction}"`,
          `Progress so far:\n${stepBullets(state.accumulatedSteps) || '(none)'}`,
          'Propose the next single concrete task that moves toward the goal.',
        ].join('\n\n');
      case 'execute':
        return state.task?.description ?? state.originalInstruction;
      case 'evaluate':
        return [
          `Original instruction: "${state.originalInstruction}"`,
          `Latest task result:\n${state.lastOutput || '(none)'}`,
          'Decide whether the goal has been fully met.',
        ].join('\n\n');
      default:
        return state.originalInstruction;
    }
  }
}

/** Planify phase result: the model replies with an AgentTask JSON — take `description` (or raw). */
function parsePhaseTask(content: string): string {
  try {
    const parsed = JSON.parse(content.trim()) as Record<string, unknown>;
    if (typeof parsed.description === 'string' && parsed.description.trim() !== '') {
      return parsed.description.trim();
    }
  } catch {
    /* not JSON — use the raw text as the task description */
  }
  return content.trim();
}
