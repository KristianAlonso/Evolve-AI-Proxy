// The chat-completion use case (application layer): the whole pipeline behind
// POST /v1/chat/completions — incoming capture, model + context-window resolution, ADR
// A-007/A-009/A-010 wiring, the FASE 6 tri-partition (A-006), the inline agent loop and all
// session bookkeeping.
//
// The presentation layer parses the HTTP request into a ChatCompletionInput and hands it in;
// every byte back to the client goes through the ResponseChannel port
// (`application/response-channel.ts`). No Fastify, no reply, no writer.

import { AgentLoop, type FinalResultData, type LoopOptions } from '../domain/agent-loop.js';
import { SubagentOrchestrator, type SubagentBinding } from '../domain/orchestrator.js';
import { newLoopState, type LoopStateData } from '../domain/loop-state.js';
import { detectTypeDrift, isSubagentContinuation, parseSubagentEnvelope } from '../domain/subagent-spawn.js';
import { mapSubagentTool } from '../domain/subagent-mapper.js';
import { isCompactionRequest, toInternalMessages } from '../domain/phase-prompts.js';
import { callWithStreaming } from '../domain/stream-helper.js';
import type { ChatProvider } from '../domain/provider/types.js';
import { SessionStore } from '../domain/session-store.js';
import type { TraceLogger } from '../domain/logging.js';
import type { ProxyRequest, ToolCall, ToolChoice, ToolDefinition, UpstreamMessage } from '../domain/types.js';
import { captureIncomingRequest, type CapturedRequestSource } from '../infrastructure/capture.js';
import { buildPassthrough } from './passthrough.js';
import { ModelResolver } from './model-resolution.js';
import { finishReason, textCompletion, toFinalResult, toOpenAICompletion } from './openai-completion.js';
import { ChannelSink, type ResponseChannel } from './response-channel.js';

export interface ChatCompletionDeps {
  sessionStore: SessionStore;
  /** Fraction of the context window at which compaction is delegated to the client (A-008). */
  compactThreshold: number;
}

export interface ChatCompletionInput {
  /** The provider for this request (one traced logger per request, created at the HTTP edge). */
  provider: ChatProvider;
  body: Partial<ProxyRequest>;
  stream: boolean;
  sessionId: string | undefined;
  traceId: string;
  log: TraceLogger;
  /** Stop propagation (SC-023): abort the in-flight upstream call when the client goes away. */
  abort: AbortSignal;
  channel: ResponseChannel;
  /** Wire facts for the incoming-request capture. */
  remote: CapturedRequestSource;
  headers: Record<string, unknown>;
}

export class ChatCompletionService {
  constructor(private readonly deps: ChatCompletionDeps) {}

  /** Run the full chat-completion request. Every byte out goes through `input.channel`. */
  async handle(req: ChatCompletionInput): Promise<void> {
    const { body, stream, sessionId, traceId, log, abort, channel } = req;
    const provider = req.provider;
    const store = this.deps.sessionStore;
    const requestStart = Date.now();

    log.info(
      `POST /v1/chat/completions: model="${(body.model ?? '').trim()}" stream=${!!body.stream} ` +
      `messages=${(body.messages ?? []).length} tools=${body.tools?.length ?? 0} ` +
      `tool_choice=${body.tool_choice ?? '-'} session=${sessionId ?? '-'}`,
    );
    captureIncomingRequest({
      traceId,
      remote: req.remote,
      headers: req.headers,
      sessionId: sessionId ?? '-',
      body,
      log,
    });

    // The model comes from the request body, and only from `body.model` — there is no
    // header-based override on this route. It still stands alone for every client, so
    // resolution maps it against `/v1/models` (SC-016/SC-024 + AUTO_RESOLVE_MODEL).
    const model: string = (body.model ?? '').trim();

    // One `/v1/models` fetch per request (memoized in the resolver), shared by the alias
    // resolution and the context-window lookup.
    const resolver = new ModelResolver(provider);
    const concreteModel = await resolver.resolveModel(model);
    log.info(`model resolution: "${model}" -> "${concreteModel}" (${await resolver.describe(model, concreteModel)})`);

    // Map evolve controls down to orchestrator options. `tools`/`tool_choice` carry the client's
    // delegated tools (FASE 2): only the loop's execute step forwards them to the upstream.
    // ADR A-007 (passthrough-intacto): everything the client sent in the body — except the fields
    // the proxy itself transforms (messages/model/stream/tools/tool_choice) or owns (evolve
    // controls) — rides verbatim into EVERY upstream call (loop phases, subagent phases, the
    // mapper). No invented defaults, no dropped parameters.
    const passthrough = buildPassthrough(body, sessionId);

    const loopOpts: LoopOptions = {
      max_rounds: body.max_rounds ?? 10,
      max_retries: body.max_retries ?? 3,
      doom_loop_threshold: body.doom_loop_threshold ?? 4,
      context_window_size: await resolver.contextWindow(body),
      model: concreteModel,
      tools: body.tools,
      tool_choice: body.tool_choice,
      logger: log,
      traceId,
      abort_signal: abort,
      passthrough,
      compact_threshold: this.deps.compactThreshold,
    };
    log.info(`loop configured: max_rounds=${loopOpts.max_rounds} max_retries=${loopOpts.max_retries} context_window=${loopOpts.context_window_size}`);

    const messages = (body.messages ?? []) as UpstreamMessage[];

    // The natural-language instruction for the loop. A request with no user/system turn is
    // structurally invalid, so validation rejects it as 400 up-front (SC-016/SC-024) before any
    // loop work runs — we therefore always reach here with an actionable message to act on.
    const instruction = firstText(messages);

    const session = sessionId ? store.get(sessionId) : undefined;

    // ---- FASE 6: tri-partition for subagent phase delegation (R3) -----------------------------
    // A request with client tools plays exactly one role:
    //   1. SUBAGENT — its prompt carries a spawn envelope (or it is a bound subagent session).
    //      First request of a phase: the proxy runs that ONE phase from the parent's stored loop
    //      state. Later requests (the subagent iterating internally) are served normally, and
    //      their final content updates the parent's phase result (last content wins).
    //   2. PARENT RESUME — the request's own session holds a loopState: consume the finished
    //      phase result, emit the next spawn ToolCall or the final answer.
    //   3. NEW PARENT — no stored session: map the spawn tool + interpret + spawn(planify).
    //      Mapping failure (no subagent tool) returns null and falls through to the classic
    //      inline agent loop below — the fail-safe that guarantees no request ever breaks.
    // Everything else (no tools, FASE 2 native delegation, standalone chats) is served by the
    // classic inline agent loop exactly as before.
    // ---- Pure passthrough requests ("como si nada", ADR A-007/A-009): one upstream call with
    // the client's messages untouched — no loop, no orchestrator, NO session reads or writes.
    // Two kinds:
    //   * the client's OWN context-compaction request. The upstream reply (the summary) becomes
    //     the client's new context; its NEXT request resumes the interrupted phase (orchestrator
    //     compactPending branch / fresh inline loop).
    //   * requests WITHOUT client tools (ADR A-009): auxiliary client calls (session-title
    //     generation, etc.) and plain standalone chats. They must NOT run the agent loop:
    //     without tools the loop has nothing to execute, it only multiplies upstream calls —
    //     and a completing inline loop would delete the shared session, wiping the parent's
    //     loopState and forcing the whole flow to restart (observed with OpenCode's title
    //     generator, which reuses the parent session id). This branch runs BEFORE the
    //     envelope/loopState routing for exactly that reason.
    const hasTools = !!body.tools && body.tools.length > 0;

    if (isCompactionRequest(messages) || !hasTools) {
      const kind = isCompactionRequest(messages) ? 'compaction' : 'no-tools';
      log.info(`${kind} request: model="${concreteModel}" stream=${!!body.stream} messages=${messages.length} — pure passthrough to upstream`);
      await this.servePurePassthrough({
        provider,
        model: concreteModel,
        messages,
        stream: !!body.stream,
        channel,
        log,
        traceId,
        abort,
        passthrough,
        meta: kind === 'compaction' ? { compaction: true, trace_id: traceId } : { passthrough: 'no_tools', trace_id: traceId },
      });
      log.info(`request done (${kind} passthrough): stream=${!!body.stream} elapsed=${Date.now() - requestStart}ms`);
      return;
    }

    const envelope = parseSubagentEnvelope(messages);

    if (envelope) {
      const parent = store.get(envelope.envelope.parent_session_id);
      if (parent?.loopState) {
        const binding: SubagentBinding = { agentId: envelope.envelope.agent_id, phase: envelope.envelope.phase };
        if (isSubagentContinuation(messages, envelope.index)) {
          // ---- SUBAGENT CONTINUATION — pure passthrough (A-009) --------------------------------
          // The subagent's first request already ran the delegated phase; these later requests
          // are the subagent ITERATING ON ITS OWN TASK. Its conversation belongs to the
          // subagent's LLM (the client runs the tools); the proxy forwards the pile verbatim —
          // one upstream call, no loop, no orchestrator. Injecting the inline agent loop here
          // (the old "serving as a normal request" fall-through) ran interpret/planify/execute/
          // evaluate ON TOP OF the subagent's own conversation: the execute subagent got a nested
          // loop instead of focusing on its task, and every continuation tripled the upstream
          // calls. Recorded (last content wins) so the parent's phase result is still refreshed.
          log.info(
            `subagent continuation: parent=${parent.sessionId} agent_id=${binding.agentId} ` +
              `phase=${binding.phase} — pure passthrough (A-009): the subagent's own LLM continues its conversation (no loop, no orchestrator)`,
          );
          const out = await this.servePurePassthrough({
            provider,
            model: concreteModel,
            messages,
            stream: !!body.stream,
            channel,
            log,
            traceId,
            abort,
            passthrough,
            tools: body.tools,
            tool_choice: body.tool_choice,
            meta: { passthrough: 'subagent_continuation', trace_id: traceId },
          });
          this.recordSubagentResult(store, { parentSessionId: parent.sessionId, agentId: binding.agentId }, this.passthroughAsFinalResult(out), log);
          log.info(`request done (subagent continuation passthrough): stream=${!!body.stream} elapsed=${Date.now() - requestStart}ms`);
          return;
        } else {
          // First request of this subagent: register the binding (lets its follow-up requests
          // route even after the spawn prompt is no longer the last message) and run the phase.
          if (sessionId) {
            parent.subagentBindings = {
              ...(parent.subagentBindings ?? {}),
              [sessionId]: { parentSessionId: parent.sessionId, agentId: binding.agentId, phase: binding.phase },
            };
          }
          store.save(parent);
          await this.handleSubagentPhase({
            provider,
            state: parent.loopState,
            binding,
            model: concreteModel,
            tools: body.tools,
            tool_choice: body.tool_choice,
            stream: !!body.stream,
            channel,
            log,
            traceId,
            abort,
            passthrough,
          });
          log.info(`request done (subagent phase): parent=${parent.sessionId} agent_id=${binding.agentId} phase=${binding.phase} stream=${!!body.stream} elapsed=${Date.now() - requestStart}ms`);
          return;
        }
      } else {
        log.warn(`subagent envelope but parent ${envelope.envelope.parent_session_id} has no loop state (TTL eviction?) — serving as a normal request`);
      }
    } else if (session?.loopState && sessionId) {
      // PARENT RESUME: no upstream call happens here — the phase already ran in the subagent's
      // request; we only consume the stored result and emit the next spawn (or the final answer).
      //
      // TYPE DRIFT: the client can change the list of subagent types it offers between requests
      // (or rename the spawn tool). This branch is the parent's own conversation (subagent
      // phase requests take the envelope branch above), so it is the only place to refresh the
      // mapping. The drift check itself is deterministic (it reads the type argument's `enum`
      // from the incoming tools schema — no model involved); only when drift is confirmed do we
      // re-run the mapping to get a new spec. If the remap fails, the previous spec is kept.
      if (session.loopState.spec && body.tools && body.tools.length > 0 && detectTypeDrift(session.loopState.spec, body.tools)) {
        const previousType = session.loopState.activeTypeId;
        const remapped = await mapSubagentTool(provider, body.tools, {
          model: session.model,
          logger: log,
          traceId,
          abort_signal: abort,
          passthrough,
        });
        if (remapped) {
          log.warn(
            `orchestrator resume: subagent type list drifted (previous type="${previousType}" no longer exists) — remapped ` +
              `type="${remapped.typeId}" available=[${remapped.availableTypes.map((t) => t.id).join(',')}]`,
          );
          session.loopState.spec = remapped;
          session.loopState.activeTypeId = remapped.typeId; // the old type cannot be used anymore
          session.loopState.spawnRetries = 0;
        } else {
          log.warn(`orchestrator resume: type drift detected but remap failed — keeping previous spec (type="${previousType}")`);
        }
      }
      const orchestrator = new SubagentOrchestrator(provider, log, loopOpts.compact_threshold);
      // The parent's pile already holds the consumed phase result (as the spawn tool's result):
      // the orchestrator refreshes its base from it (ADR A-008 delegated flow).
      const outcome = orchestrator.resume(session.loopState, sessionId, messages);
      const finalResult = toFinalResult(session.loopState, outcome);
      if (stream) {
        const sink = new ChannelSink(channel);
        if (outcome.kind === 'tool_call' && outcome.toolCall) {
          sink.emitReasoningDelta(0, `[orchestrator] delegating phase "${session.loopState.stage} (round ${session.loopState.round})" to a subagent\n`);
          sink.emitToolCalls([outcome.toolCall]);
        } else {
          sink.emitContent(0, outcome.finalOutput);
        }
        channel.emitFinish(finishReason(outcome.decision).reason, outcome.usage ?? undefined);
        channel.endStream();
        log.info(`request done (orchestrator resume, stream): decision=${outcome.decision} frames=${channel.frames} elapsed=${Date.now() - requestStart}ms`);
      } else {
        channel.sendCompletion(toOpenAICompletion(concreteModel, finalResult, traceId));
        log.info(`request done (orchestrator resume): decision=${outcome.decision} elapsed=${Date.now() - requestStart}ms`);
      }
      if (outcome.kind === 'tool_call' && outcome.toolCall) {
        store.save({ ...session, loopState: session.loopState, pendingToolCalls: [outcome.toolCall], updatedAt: Date.now() });
      } else {
        store.delete(sessionId);
      }
      return;
    } else if (body.tools && body.tools.length > 0 && sessionId && !session) {
      // NEW PARENT: orchestrator mode. `started === null` (the client offers no subagent-spawn
      // tool, or the model could not map it) -> fall through to the inline agent loop below.
      const state = newLoopState({
        originalInstruction: instruction,
        internalMessages: toInternalMessages(messages),
        max_rounds: body.max_rounds ?? 10,
        tools: body.tools,
        tool_choice: body.tool_choice,
        spec: null,
        context_window_size: loopOpts.context_window_size,
      });
      const started = await new SubagentOrchestrator(provider, log, loopOpts.compact_threshold).start({
        state,
        sessionId,
        model: concreteModel,
        // Only for streaming requests: the SseWriter commits the SSE headers on the first frame,
        // so binding it for a non-stream JSON reply would corrupt the reply once any frame goes out.
        makeSink: stream ? () => new ChannelSink(channel) : undefined,
        traceId,
        abort_signal: abort,
        passthrough,
      });
      if (started) {
        const { outcome } = started;
        const finalResult = toFinalResult(state, outcome);
        if (stream) {
          const sink = started.sink ?? new ChannelSink(channel);
          if (outcome.kind === 'tool_call' && outcome.toolCall) {
            sink.emitReasoningDelta(0, `[orchestrator] delegating phase "${state.stage} (round ${state.round})" to a subagent\n`);
            sink.emitToolCalls([outcome.toolCall]);
          } else {
            sink.emitContent(0, outcome.finalOutput);
          }
          channel.emitFinish(finishReason(outcome.decision).reason, outcome.usage ?? undefined);
          channel.endStream();
          log.info(`request done (orchestrator start, stream): decision=${outcome.decision} frames=${channel.frames} elapsed=${Date.now() - requestStart}ms`);
        } else {
          channel.sendCompletion(toOpenAICompletion(concreteModel, finalResult, traceId));
          log.info(`request done (orchestrator start): decision=${outcome.decision} elapsed=${Date.now() - requestStart}ms`);
        }
        store.save({
          sessionId,
          model: concreteModel,
          tools: body.tools,
          tool_choice: body.tool_choice,
          pendingToolCalls: outcome.kind === 'tool_call' && outcome.toolCall ? [outcome.toolCall] : [],
          loopState: state,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        return;
      }
      // Mapping failed — the inline agent loop below serves this request (classic FASE 2/3 path).
    }

    if (stream) {
      const finalResult = await this.runInlineStream(provider, loopOpts, messages, instruction, channel, log);
      if (finalResult) {
        log.info(
          `request done (stream): decision=${finalResult.decision} iterations=${finalResult.iterations_completed} ` +
          `upstream_calls=${finalResult.reasoning_traces_summary.total_upstream_calls} elapsed=${Date.now() - requestStart}ms`,
        );
        this.toolDelegateBookkeeping(store, sessionId, concreteModel, body, finalResult, log);
      }
      return; // The channel has already written frames + ended the stream.
    } else {
      const finalResult = await this.runInlineJson(provider, loopOpts, messages, instruction);
      this.toolDelegateBookkeeping(store, sessionId, concreteModel, body, finalResult, log);
      this.toolDelegateBookkeeping(store, sessionId, concreteModel, body, finalResult, log);
      log.info(
        `request done: decision=${finalResult.decision} iterations=${finalResult.iterations_completed} ` +
        `upstream_calls=${finalResult.reasoning_traces_summary.total_upstream_calls} elapsed=${Date.now() - requestStart}ms`,
      );
      channel.sendCompletion(toOpenAICompletion(concreteModel, finalResult, traceId));
    }
  }

  /**
   * Pure passthrough ("como si nada"): one upstream call with the client's messages untouched;
   * the reply goes back as-is (SSE if the client streamed, JSON if not). No agent loop, no
   * orchestrator, and — critically — no session reads or writes: auxiliary client calls that
   * share a session id (e.g. OpenCode's title generator) must never create, save or delete
   * loop state.
   */
  private async servePurePassthrough(params: {
    provider: ChatProvider;
    model: string;
    messages: UpstreamMessage[];
    stream: boolean;
    channel: ResponseChannel;
    log: TraceLogger;
    traceId: string;
    abort: AbortSignal;
    passthrough?: Record<string, unknown>;
    meta: Record<string, unknown>;
    /** Client tools forwarded verbatim (subagent continuation — A-009). */
    tools?: ToolDefinition[];
    tool_choice?: ToolChoice;
  }): Promise<{ content: string; tool_calls: ToolCall[]; usage: import('../domain/types.js').TokenUsage | null } | null> {
    const { provider, model, messages, stream, channel, log, traceId, abort, passthrough, meta, tools, tool_choice } = params;
    const options = { logger: log, trace_id: traceId, abort_signal: abort, passthrough, tools, tool_choice };
    if (stream) {
      try {
        const { result } = await callWithStreaming({
          provider,
          model,
          messages,
          options,
          surfaceDelta: (chunk) => {
            const reasoning = typeof chunk.reasoning === 'string' ? chunk.reasoning : '';
            const content = typeof chunk.content === 'string' ? chunk.content : '';
            if (reasoning !== '') channel.emitReasoningDelta(0, reasoning);
            if (content !== '') channel.emitContent(0, content);
          },
        });
        // Relay the delegated tool calls as OpenAI tool_calls chunks BEFORE the finish chunk.
        // Without this the client only sees `finish_reason: "tool_calls"` with no call data and
        // silently drops the calls — the subagent then ends its loop with an empty result
        // (verified in the 15:14 live run: the `bash` call was lost on the client side).
        if (result.tool_calls && result.tool_calls.length > 0) {
          channel.emitToolCalls(result.tool_calls);
        }
        // Propagate the real finish reason: with tools, a tool_calls finish means the client must
        // execute them and continue (subagent continuation), not treat the turn as final.
        channel.emitFinish(result.finish_reason ?? 'stop', result.usage);
        channel.endStream();
        return { content: result.content ?? '', tool_calls: result.tool_calls ?? [], usage: result.usage ?? null };
      } catch (err) {
        if (abort.aborted) {
          // The client stopped the request — nothing left to say to it.
          log.warn(`passthrough aborted by client: ${String(err)}`);
          return null;
        }
        log.error(`passthrough upstream failed: ${String(err)}`);
        channel.failStream(err);
        return null;
      }
    } else {
      try {
        const { result } = await callWithStreaming({ provider, model, messages, options });
        channel.sendCompletion(textCompletion({
          model,
          content: result.content ?? '',
          usage: result.usage,
          toolCalls: result.tool_calls ?? [],
          finishReason: result.finish_reason ?? undefined,
          meta,
        }));
        return { content: result.content ?? '', tool_calls: result.tool_calls ?? [], usage: result.usage ?? null };
      } catch (err) {
        if (abort.aborted) {
          // The client stopped the request — nothing left to say to it.
          log.warn(`passthrough aborted by client: ${String(err)}`);
          return null;
        }
        log.error(`passthrough upstream failed: ${String(err)}`);
        channel.sendUpstreamError(err);
        return null;
      }
    }
  }

  /**
   * Adapt a passthrough outcome to a FinalResultData so recordSubagentResult keeps its contract:
   * a reply with delegated tool calls is NOT a phase result (the subagent is still iterating —
   * 'tool_calls_pending' is skipped by the recorder); otherwise the content is (last content
   * wins).
   */
  private passthroughAsFinalResult(
    out: { content: string; tool_calls: ToolCall[]; usage: import('../domain/types.js').TokenUsage | null } | null,
  ): FinalResultData {
    return {
      final_output: out?.content ?? '',
      iterations_completed: 0,
      decision: out && out.tool_calls.length > 0 ? 'tool_calls_pending' : 'complete',
      max_rounds: 0,
      tasks_executed: [],
      reasoning_traces_summary: { phases_completed: [], total_upstream_calls: 1, errors_occurred: 0 },
      accumulated_context: out?.content ?? '',
      tool_calls: out?.tool_calls ?? [],
      usage: out?.usage ?? undefined,
    };
  }

  /**
   * FASE 6: run ONE delegated phase for a subagent's first request. The phase output is what the
   * subagent's client receives as its assistant content (R2: content = the actual answer, reasoning
   * = live thinking). The parent consumes it later from its stored loop state.
   */
  private async handleSubagentPhase(params: {
    provider: ChatProvider;
    state: LoopStateData;
    binding: SubagentBinding;
    model: string;
    tools?: ToolDefinition[];
    tool_choice?: ToolChoice;
    stream: boolean;
    channel: ResponseChannel;
    log: TraceLogger;
    traceId: string;
    abort: AbortSignal;
    passthrough?: Record<string, unknown>;
  }): Promise<void> {
    const { channel, log, traceId, model, stream, abort, provider, state, binding } = params;
    const orchestrator = new SubagentOrchestrator(provider, log, this.deps.compactThreshold);
    const start = Date.now();
    try {
      if (stream) {
        const sink = new ChannelSink(channel);
        const out = await orchestrator.runSubagentPhase({
          state, binding, model, tools: params.tools, tool_choice: params.tool_choice, sink, traceId, abort_signal: abort, passthrough: params.passthrough,
        });
        // Propagate the model's real finish reason: when it invoked the client's tools the
        // client must execute them and continue this subagent session — a forced 'stop'
        // made it treat the phase as finished and drop the tool calls.
        channel.emitFinish(out.finish_reason ?? 'stop', out.usage ?? undefined);
        channel.endStream();
        log.info(`subagent phase done (stream): phase=${binding.phase} agent_id=${binding.agentId} finish=${out.finish_reason ?? 'stop'} output_len=${out.content.length} frames=${channel.frames} elapsed=${Date.now() - start}ms`);
      } else {
        const out = await orchestrator.runSubagentPhase({
          state, binding, model, tools: params.tools, tool_choice: params.tool_choice, traceId, abort_signal: abort, passthrough: params.passthrough,
        });
        channel.sendCompletion(textCompletion({
          model,
          content: out.content,
          usage: out.usage ?? undefined,
          toolCalls: out.tool_calls,
          finishReason: out.finish_reason ?? undefined,
          meta: { subagent_phase: binding.phase, agent_id: binding.agentId, compact_pending: out.compactPending, trace_id: traceId },
        }));
        log.info(`subagent phase done: phase=${binding.phase} agent_id=${binding.agentId} output_len=${out.content.length} elapsed=${Date.now() - start}ms`);
      }
    } catch (err) {
      if (!abort.aborted) {
        log.error(`subagent phase failed: ${String(err)}`);
        channel.failStream(err);
      }
    }
  }

  /**
   * FASE 6: the subagent's LAST content is the canonical phase result. After a subagent
   * continuation request is served as a normal request, record its final content into the
   * parent's stored phase result (last content wins — the subagent may have iterated internally).
   */
  private recordSubagentResult(
    store: SessionStore,
    subagentUpdate: { parentSessionId: string; agentId: string } | null,
    finalResult: FinalResultData,
    log: TraceLogger,
  ): void {
    if (!subagentUpdate) return;
    const parent = store.get(subagentUpdate.parentSessionId);
    if (!parent?.loopState) {
      log.warn(`subagent result discarded: parent ${subagentUpdate.parentSessionId} has no loop state anymore`);
      return;
    }
    // An in-flight tool delegation is NOT a phase result: the subagent is still running its
    // tools. Record only terminal decisions — last content wins.
    if (finalResult.decision === 'tool_calls_pending') {
      return;
    }
    parent.loopState.phaseResults[subagentUpdate.agentId] = finalResult.final_output;
    store.save(parent);
    log.info(
      `subagent result recorded: parent=${subagentUpdate.parentSessionId} agent_id=${subagentUpdate.agentId} output_len=${finalResult.final_output.length}`,
    );
  }

  /** FASE 2 bookkeeping: when the loop paused on delegated tool calls, record the pending state under
   *  the request's session id; on any terminal decision, clear a session that was awaiting a resume.
   *  A resume (assistant tool_calls + tool results re-sent on the same session) needs no explicit
   *  flag — the conversation transcript already carries the exchange.
   */
  private toolDelegateBookkeeping(
    store: SessionStore,
    sessionId: string | undefined,
    model: string,
    body: Partial<ProxyRequest>,
    finalResult: FinalResultData,
    log: TraceLogger,
  ): void {
    if (!sessionId) return;
    if (finalResult.decision === 'tool_calls_pending') {
      store.save({
        sessionId,
        model,
        tools: body.tools,
        tool_choice: body.tool_choice,
        pendingToolCalls: finalResult.tool_calls,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      log.info(`session store: saved pending tool delegation for session=${sessionId} (${finalResult.tool_calls.length} call(s))`);
    } else {
      store.delete(sessionId);
      log.info(`session store: cleared session=${sessionId} (terminal decision=${finalResult.decision})`);
    }
  }

  /**
   * SSE stream handler: write valid OpenAI chat-completion chunks as the single loop run
   * progresses. The whole response IS that stream — no pre-stream frames, no custom SSE events.
   */
  private async runInlineStream(
    provider: ChatProvider,
    opts: LoopOptions,
    messages: UpstreamMessage[],
    instruction: string,
    channel: ResponseChannel,
    log: TraceLogger,
  ): Promise<FinalResultData | undefined> {
    const sink = new ChannelSink(channel);
    const streamStart = Date.now();
    log.info(`stream start: frames so far=0`);
    try {
      const loop = new AgentLoop(provider, sink, opts);
      const result = await loop.run(instruction, messages);
      const finalResult = result.finalResult;
      channel.emitFinish(finishReason(result.decision).reason, finalResult.usage);
      channel.endStream();
      log.info(`stream end: frames=${channel.frames} elapsed=${Date.now() - streamStart}ms decision=${result.decision}`);
      return finalResult;
    } catch (err) {
      if (sink.isDisconnected()) {
        log.warn(`stream aborted by client disconnect: frames=${channel.frames} elapsed=${Date.now() - streamStart}ms`);
      } else {
        log.error(`stream error (frames=${channel.frames}, elapsed=${Date.now() - streamStart}ms): ${String(err)}`);
        channel.failStream(err);
      }
    }
    return undefined;
  }

  /** Run the agent loop without a sink (non-stream path). */
  private async runInlineJson(
    provider: ChatProvider,
    opts: LoopOptions,
    messages: UpstreamMessage[],
    instruction: string,
  ): Promise<FinalResultData> {
    const loop = new AgentLoop(provider, undefined, opts);
    const result = await loop.run(instruction, messages);
    return result.finalResult;
  }
}

/**
 * The natural-language instruction for the loop: the FIRST `user` turn's content.
 *
 * `originalInstruction` is the USER's instruction (the "Hola", the task, the goal) — NOT the
 * system prompt. The system prompt (opencode's "montón", AGENTS.md, skills, swarm context)
 * already travels in `state.internalMessages` (the parent's message history); it must NOT be
 * duplicated into `originalInstruction`. The phase instructions (planify/execute/evaluate)
 * are built from `originalInstruction` alone, so it must be the user's message only.
 */
function firstText(messages: UpstreamMessage[]): string {
  return messages.find((m) => m.role === 'user' && typeof m.content === 'string')?.content ?? '';
}
