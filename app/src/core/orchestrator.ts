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

import env from '../config.js';
import { isAbortError } from '../provider/types.js';
import type { ChatProvider } from '../provider/types.js';
import type { TraceLogger } from '../logger.js';
import type { LoopDecision, TokenUsage, ToolCall, ToolChoice, ToolDefinition, UpstreamMessage } from '../types.js';
import { mapSubagentTool } from './subagent-mapper.js';
import { interpretRequest } from './interpreter.js';
import { classifyEvaluation } from './evaluator.js';
import { callWithStreaming } from './stream-helper.js';
import {
  buildEvaluateInstruction,
  buildPhasePrompt,
  buildPlanifyInstruction,
  COMPACT_PENDING_NOTICE,
  contextFull,
  estimatePromptTokens,
  goalHintForPlanify,
  INTERPRET_INSTRUCTION,
  isStructuredRejection,
  toInternalMessages,
  toRenderedMessages,
} from './phase-prompts.js';
import { buildSpawnToolCall, newAgentId, type DelegatedPhase } from './subagent-spawn.js';
import type { LoopStateData } from './loop-state.js';
import type { LoopSink } from './agent-loop.js';

/** One delegated subagent: its agent_id + the phase it is running. */
export interface SubagentBinding {
  agentId: string;
  phase: DelegatedPhase;
}

/** What a parent-facing orchestrator outcome carries to the routes layer. */
export interface OrchestratorOutcome {
  /** 'tool_call' = the parent must call the spawn tool (stream/JSON carries the ToolCall).
   *  'final' = the loop is over; `finalOutput` = the client's answer. */
  kind: 'tool_call' | 'final';
  toolCall?: ToolCall;
  decision: LoopDecision;
  finalOutput: string;
  /** Real upstream usage to relay to the client (its token tracking drives the client-side compaction). */
  usage: TokenUsage | null;
}

export class SubagentOrchestrator {
  constructor(
    private provider: ChatProvider,
    private logger: TraceLogger,
    /** Fraction of the context window at which compaction is delegated to the client (env-driven by default). */
    private compactThreshold: number = env.CONTEXT_COMPACT_THRESHOLD,
  ) {}

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
    /** ADR A-007 (passthrough-intacto): the client's request parameters, forwarded as-is. */
    passthrough?: Record<string, unknown>;
  }): Promise<{ outcome: OrchestratorOutcome; sink?: LoopSink } | null> {
    const { state, sessionId, model } = args;

    const spec = await mapSubagentTool(this.provider, state.tools ?? [], {
      model,
      logger: this.logger,
      traceId: args.traceId,
      abort_signal: args.abort_signal,
      passthrough: args.passthrough,
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
    // Real-time phase announcement (reasoning delta — wire stays 100% OpenAI).
    sink?.emitReasoningDelta(0, '[interpret] analyzing the request to derive the objective and sub-objectives\n');
    // ADR A-008: client base verbatim + last intermediate message + instruction (user, appended).
    // Never truncated: if the context is already past the compaction threshold after this call,
    // the loop is interrupted and the compaction is delegated to the client (compactPending).
    const interpretOpts = { model, logger: this.logger, traceId: args.traceId, abort_signal: args.abort_signal, passthrough: args.passthrough };
    const interpretPrompt = (rendered: boolean) =>
      buildPhasePrompt(rendered ? toRenderedMessages(state.internalMessages) : state.internalMessages, state.lastMessage || null, INTERPRET_INSTRUCTION);
    let interp;
    try {
      interp = await interpretRequest(this.provider, interpretPrompt(state.fellBackToRendered), interpretOpts, sink);
    } catch (err) {
      if (!state.fellBackToRendered && isStructuredRejection(err) && !isAbortError(err) && !args.abort_signal?.aborted) {
        state.fellBackToRendered = true;
        this.logger.warn('orchestrator interpret: upstream rejected structured conversation — retrying rendered (sticky)');
        interp = await interpretRequest(this.provider, interpretPrompt(true), interpretOpts, sink);
      } else {
        throw err;
      }
    }
    const { interpretation } = interp;
    // ADR A-008: the interpretation raw becomes the process' last intermediate message.
    state.lastMessage = interp.raw || '';
    state.totalUpstreamCalls += 1;
    state.interpretation = interpretation;
    state.stage = 'planify';
    state.lastUsage = interp.usage ?? null;
    // Client-delegated compaction: the context is already at/over the threshold (the client's
    // own tracking will agree once it relays the usage). The spawn is still emitted, but the
    // subagent's phase call is PRE-BLOCKED (notice, no upstream call) until the client compacts.
    if (contextFull(interp.usage, state.context_window_size, this.compactThreshold)) {
      state.compactPending = true;
      this.logger.warn(
        `orchestrator start: context at ${interp.usage?.prompt_tokens}/${state.context_window_size} tokens (>= ${Math.round(this.compactThreshold * 100)}%) — ` +
        `interrupting before the delegated phase; waiting for the client to compact and resume`,
      );
    }
    this.logger.info(
      `orchestrator start: interpret ${Date.now() - t0}ms objective="${interpretation.mainObjective.replace(/\s+/g, ' ').slice(0, 160)}"`,
    );

    return {
      outcome: {
        kind: 'tool_call',
        toolCall: this.emitSpawn(state, sessionId),
        decision: 'tool_calls_pending',
        finalOutput: '',
        usage: state.lastUsage,
      },
      sink,
    };
  }

  /**
   * Parent resume: consume the stored phase result, advance the stage machine, then either emit
   * the next spawn ToolCall or deliver the final answer. Synchronous — no upstream call happens
   * here (the phase already ran in the subagent's request).
   *
   * The parent's incoming pile (`incomingMessages`) already contains the consumed phase output
   * (as the spawn tool's result) — the client persisted it. After consumption the base is
   * refreshed from that pile and `state.lastMessage` is cleared: the delegated flow never carries
   * a second copy of a phase output (it only rides the parent's own conversation).
   */
  resume(state: LoopStateData, sessionId: string, incomingMessages?: UpstreamMessage[]): OrchestratorOutcome {
    if (state.stage !== 'done') {
      // Client-delegated compaction in flight: the interrupted phase's result is NOT consumed
      // (it is a pause notice, never a real output). Adopt the client's incoming pile — that is
      // the whole of the new (compacted) context — and re-emit the pending spawn. While the
      // incoming pile is still at/over the threshold the spawn is re-emitted STABLY (same
      // agent_id); the subagent's phase call stays pre-blocked (no upstream call, no overflow).
      if (state.compactPending) {
        if (incomingMessages && incomingMessages.length > 0) {
          state.internalMessages = toInternalMessages(incomingMessages);
        }
        const estimate = estimatePromptTokens(
          buildPhasePrompt(state.internalMessages, state.lastMessage || null, this.phaseInstructionFor(state)),
        );
        const stillFull = contextFull({ prompt_tokens: estimate }, state.context_window_size, this.compactThreshold);
        if (stillFull) {
          this.logger.warn(
            `orchestrator resume: compactPending and the incoming context is still over the threshold ` +
            `(estimate=${estimate} tokens, window=${state.context_window_size}, threshold=${Math.round(this.compactThreshold * 100)}%) — ` +
            `re-emitting the pending spawn (agent_id=${state.pendingAgentId ?? '-'}, stage=${state.stage} round=${state.round})`,
          );
          return {
            kind: 'tool_call',
            toolCall: this.emitSpawn(state, sessionId, state.pendingAgentId ?? undefined),
            decision: 'tool_calls_pending',
            finalOutput: '',
            usage: state.lastUsage,
          };
        }
        // The client actually compacted: DISCARD the old stored context entirely and continue
        // the interrupted phase with the new (compacted) pile.
        state.compactPending = false;
        state.lastMessage = ''; // the interrupted intermediate output is stale — drop it
        if (state.pendingAgentId) delete state.phaseResults[state.pendingAgentId]; // pause notice — not a result
        state.pendingAgentId = null;
        state.spawnRetries = 0;
        this.logger.info(
          `orchestrator resume: client compacted the context (estimate=${estimate} tokens) — ` +
          `resuming the ${state.stage} phase (round=${state.round}) with the compacted pile`,
        );
        return {
          kind: 'tool_call',
          toolCall: this.emitSpawn(state, sessionId),
          decision: 'tool_calls_pending',
          finalOutput: '',
          usage: state.lastUsage,
        };
      }

      const agentId = state.pendingAgentId;
      const phaseResult = agentId ? state.phaseResults[agentId] : undefined;
      if (agentId && phaseResult === undefined) {
        // The subagent's phase result has not arrived: the client has not run the subagent (its
        // plugin blocked the dispatch, or it errored out). Rounds only advance once the parent
        // holds a real phase result, so a blocked/missing subagent can never spin the loop with
        // empty output.
        //
        // FAILOVER: on EVERY failure, when more than one subagent type is available, retry with
        // the NEXT type (round-robin over `spec.availableTypes`, wraps around) and a FRESH agent
        // id. With a single available type there is nothing to rotate to — re-emit the SAME
        // spawn (same agent_id) stably.
        state.spawnRetries += 1;
        const nextType = this.nextFailoverType(state);
        if (nextType) {
          this.logger.warn(
            `orchestrator failover: type="${state.activeTypeId}" produced no phase result (consecutive_failures=${state.spawnRetries}) — ` +
            `retrying with a different type="${nextType}" (stage=${state.stage} round=${state.round})`,
          );
          state.activeTypeId = nextType;
          return {
            kind: 'tool_call',
            toolCall: this.emitSpawn(state, sessionId),
            decision: 'tool_calls_pending',
            finalOutput: '',
            usage: state.lastUsage,
          };
        }
        this.logger.info(
          `orchestrator resume: no phase result yet for agent_id=${agentId} (consecutive_failures=${state.spawnRetries}, single type="${state.activeTypeId}") — re-emitting spawn (stage=${state.stage} round=${state.round})`,
        );
        return {
          kind: 'tool_call',
          toolCall: this.emitSpawn(state, sessionId, agentId),
          decision: 'tool_calls_pending',
          finalOutput: '',
          usage: state.lastUsage,
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
        // The consumed result already lives in the parent's pile (the spawn tool's result):
        // refresh the base from the incoming conversation and drop our intermediate copy.
        state.lastMessage = '';
        if (incomingMessages && incomingMessages.length > 0) {
          state.internalMessages = toInternalMessages(incomingMessages);
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
      return { kind: 'final', decision: state.decision ?? 'complete', finalOutput: state.finalOutput, usage: state.lastUsage };
    }
    return { kind: 'tool_call', toolCall: this.emitSpawn(state, sessionId), decision: 'tool_calls_pending', finalOutput: '', usage: state.lastUsage };
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
    /** ADR A-007 (passthrough-intacto): the client's request parameters, forwarded as-is. */
    passthrough?: Record<string, unknown>;
  }): Promise<{ content: string; reasoning: string; usage: TokenUsage | null; compactPending: boolean }> {
    const { state, binding, model } = args;
    const { agentId, phase } = binding;
    const t0 = Date.now();

    // Client-delegated compaction in flight: PRE-BLOCK. No upstream call is made (it would
    // overflow the window); the subagent receives a short pause notice and the pending spawn is
    // re-emitted by the parent until the client's compacted context arrives.
    if (state.compactPending) {
      this.logger.warn(
        `subagent phase: phase=${phase} agent_id=${agentId} PRE-BLOCKED — context compaction pending (no upstream call)`,
      );
      if (args.sink) {
        args.sink.emitReasoningDelta(0, `[${phase}] context compaction pending — waiting for the client to compact the conversation\n`);
      }
      return { content: COMPACT_PENDING_NOTICE, reasoning: '', usage: state.lastUsage, compactPending: true };
    }

    // ADR A-008: delegated phases use the SAME single shape as the inline loop — client base
    // verbatim + the last intermediate message (one `assistant` turn) + the instruction (user,
    // appended at the end). No system message is ever added.
    let instruction: string;
    switch (phase) {
      case 'planify':
        instruction = buildPlanifyInstruction(goalHintForPlanify(state.originalInstruction, state.lastOutput));
        break;
      case 'execute':
        instruction = state.task?.description ?? state.originalInstruction;
        break;
      case 'evaluate':
        instruction = buildEvaluateInstruction(state.originalInstruction);
        break;
      default:
        throw new Error(`unknown delegated phase: ${phase}`);
    }
    // Never truncated: if the context is over the threshold AFTER this call, the loop is
    // interrupted and the compaction is delegated to the client (compactPending + pause notice).
    const phasePrompt = (rendered: boolean) =>
      buildPhasePrompt(
        rendered ? toRenderedMessages(state.internalMessages) : state.internalMessages,
        state.lastMessage || null,
        instruction,
      );

    // Real-time phase announcement: the subagent sees, as a reasoning delta BEFORE the upstream
    // call, that the phase is starting and what it is about to do (wire stays 100% OpenAI).
    if (args.sink) {
      const what =
        phase === 'execute'
          ? (state.task?.description ?? state.originalInstruction).replace(/\s+/g, ' ').slice(0, 160)
          : phase === 'planify'
            ? 'planning the next concrete task'
            : 'checking whether the original goal has been met';
      args.sink.emitReasoningDelta(0, `[${phase}] ${what}\n`);
    }

    const runWith = async (p: UpstreamMessage[]) => {
      const out = await callWithStreaming({
        provider: this.provider,
        model,
        messages: p,
        options: {
          // Only execute carries the client's tools (A-008: same rule as the inline loop).
          tools: phase === 'execute' ? args.tools : undefined,
          tool_choice: phase === 'execute' ? args.tool_choice : undefined,
          logger: this.logger,
          trace_id: args.traceId,
          abort_signal: args.abort_signal,
          passthrough: args.passthrough,
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

    // Same sticky structured→rendered fallback as the inline loop (state.fellBackToRendered).
    let result;
    try {
      result = await runWith(phasePrompt(state.fellBackToRendered));
    } catch (err) {
      if (state.fellBackToRendered || isAbortError(err) || args.abort_signal?.aborted || !isStructuredRejection(err)) {
        throw err;
      }
      state.fellBackToRendered = true;
      this.logger.warn(`subagent ${phase}: upstream rejected structured conversation — retrying rendered (sticky, agent_id=${agentId})`);
      result = await runWith(phasePrompt(true));
    }

    state.lastUsage = result.usage ?? null;
    state.totalUpstreamCalls += 1;
    // Client-delegated compaction: the REAL upstream usage says the context is at/over the
    // threshold — interrupt. No phase result is stored (the next call will pre-block), and the
    // subagent receives a pause notice; the parent re-emits the pending spawn until the client
    // compacts and resumes (resume() then adopts the compacted pile and clears the flag).
    if (contextFull(result.usage, state.context_window_size, this.compactThreshold)) {
      state.compactPending = true;
      this.logger.warn(
        `subagent phase: phase=${phase} agent_id=${agentId} ${Date.now() - t0}ms context at ` +
        `${result.usage?.prompt_tokens}/${state.context_window_size} tokens (>= ${Math.round(this.compactThreshold * 100)}%) — ` +
        `interrupting; the client will compact and the ${phase} phase will resume with the compacted context`,
      );
      if (args.sink) {
        args.sink.emitReasoningDelta(0, `[${phase}] context compaction threshold reached — waiting for the client to compact\n`);
      }
      return { content: COMPACT_PENDING_NOTICE, reasoning: result.reasoning ?? '', usage: result.usage ?? null, compactPending: true };
    }
    state.phaseResults[agentId] = result.content ?? '';
    this.logger.info(
      `subagent phase: phase=${phase} agent_id=${agentId} ${Date.now() - t0}ms output_len=${(result.content ?? '').length}`,
    );
    return { content: result.content ?? '', reasoning: result.reasoning ?? '', usage: result.usage ?? null, compactPending: false };
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

  /** The phase instruction a delegated phase would run (estimate/bookkeeping only). */
  private phaseInstructionFor(state: LoopStateData): string {
    const stage = state.stage;
    switch (stage) {
      case 'planify':
        return buildPlanifyInstruction(goalHintForPlanify(state.originalInstruction, state.lastOutput));
      case 'execute':
        return state.task?.description ?? state.originalInstruction;
      case 'evaluate':
        return buildEvaluateInstruction(state.originalInstruction);
      default:
        return '';
    }
  }

  /**
   * Failover: the NEXT subagent type in round-robin over `spec.availableTypes` (wraps to the
   * first after the last). Null when at most one type is available — then there is nothing to
   * rotate to and the orchestrator keeps re-emitting the same spawn (stable).
   */
  private nextFailoverType(state: LoopStateData): string | null {
    const types = state.spec?.availableTypes ?? [];
    if (types.length < 2) return null;
    const idx = types.findIndex((t) => t.id === state.activeTypeId);
    const next = idx === -1 ? 0 : (idx + 1) % types.length;
    return types[next].id;
  }

  /** The "current task" description that rides in the spawn prompt (after the envelope line). */
  private spawnTaskDescription(state: LoopStateData): string {
    switch (state.stage) {
      case 'planify':
        return [
          `Goal: "${state.originalInstruction}"`,
          `Latest result so far:\n${state.lastOutput || '(none)'}`,
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
