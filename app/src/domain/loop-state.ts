// FASE 6 — serializable agent-loop state. Lives inside the parent SessionStore entry so the
// orchestrator can be RESUMED across independent HTTP requests:
//
//   1) parent first request  -> interpret + spawn(planify)
//   2) subagent request(s)   -> run the phase, store `phaseResults[agent_id]`
//   3) parent resume request -> consume the result, spawn the next phase (or finish)
//
// Every field must be plain JSON (SessionStore serializes it for TTL bookkeeping).

import type { AgentTask, ContextStep, LoopDecision, TokenUsage, ToolChoice, ToolDefinition, UpstreamMessage } from './types.js';
import type { Interpretation } from './interpreter.js';
import type { SubagentSpawnSpec } from './subagent-spawn.js';

export const ORCHESTRATOR_STAGES = ['planify', 'execute', 'evaluate', 'done'] as const;
export type OrchestratorStage = (typeof ORCHESTRATOR_STAGES)[number];

export interface LoopStateData {
  /** Which phase the parent is about to delegate next ('done' = finished, finalOutput ready). */
  stage: OrchestratorStage;
  round: number;
  max_rounds: number;
  originalInstruction: string;
  /** Sanitized internal messages of the original request (FASE 2), kept for the interpret phase. */
  internalMessages: UpstreamMessage[];
  tools?: ToolDefinition[];
  tool_choice?: ToolChoice;
  /** The mapped shape of the client's subagent-spawn tool (null = mapping failed -> inline loop). */
  spec: SubagentSpawnSpec | null;
  /**
   * The single subagent type currently in use for this session (set from `spec.typeId` at start;
   * on EVERY failed spawn (no phase result) it rotates to the next `spec.availableTypes` entry
   * in round-robin when more than one type is available, and is pinned for the rest of the
   * session once it yields a phase result).
   */
  activeTypeId: string;
  /** Consecutive failed spawns (no phase result) of the pending phase; reset on a real result. */
  spawnRetries: number;
  interpretation: Interpretation | null;
  /** The current AgentTask for the round (set after the planify phase result is consumed). */
  task: AgentTask | null;
  /** Latest execute-phase output. */
  lastOutput: string;
  /**
   * ADR A-008: the ONLY intermediate message kept in the global process. In the delegated flow
   * it holds the interpret phase's raw output until the first delegated result is consumed;
   * after that it stays '' — every phase output already lives in the PARENT's pile (as the
   * spawn tool's result) and `internalMessages` is refreshed from it on every resume.
   * Every delegated phase prompt = internalMessages + (this, as one `assistant` turn, when set)
   * + instruction (user, appended at the end).
   */
  lastMessage: string;
  /**
   * Resolved upstream context window (tokens). 0 = unknown/unlimited: the proxy never checks the
   * compaction threshold and the upstream decides (SC-022). When > 0 the loop is interrupted at
   * `CONTEXT_COMPACT_THRESHOLD` fraction of it (client-delegated compaction).
   */
  context_window_size: number;
  /**
   * Client-delegated compaction: set when a phase call's real upstream usage hit the compaction
   * threshold. While set, every new phase call is pre-blocked (no upstream call, notice only)
   * and the pending spawn is re-emitted until the client's compacted context arrives on the next
   * parent resume (which refreshes `internalMessages`, clears the flag and re-emits the phase).
   */
  compactPending: boolean;
  /** Real upstream usage of the last delegated call (relay to the client for its token tracking). */
  lastUsage: TokenUsage | null;
  /** ADR A-008 / R1: sticky — once the upstream rejects the structured conversation (4xx), every
   *  later phase of this session uses the rendered (flat) base. */
  fellBackToRendered: boolean;
  /** Metadata only (final response / trace) — never carried into phase prompts (A-008). */
  accumulatedSteps: ContextStep[];
  /** agent_id -> last content of that subagent (the canonical phase result). */
  phaseResults: Record<string, string>;
  /**
   * User steering: instruction(s) the user typed while a phase was running (detected on parent
   * resume — the trailing user turn appended to the pile past the spawn's tool result / dispatch
   * turn). Injected into the next planify + evaluate instructions so the loop incorporates the
   * new direction immediately; also stays in the refreshed base (internalMessages) so every
   * subsequent phase sees it in the conversation.
   */
  steering: string;
  /** The subagent whose result the parent is waiting for (set when a spawn ToolCall is emitted). */
  pendingAgentId: string | null;
  decision: LoopDecision | null;
  finalOutput: string;
  totalUpstreamCalls: number;
}

export function newLoopState(args: {
  originalInstruction: string;
  internalMessages: UpstreamMessage[];
  max_rounds: number;
  tools?: ToolDefinition[];
  tool_choice?: ToolChoice;
  spec: SubagentSpawnSpec | null;
  context_window_size?: number;
}): LoopStateData {
  return {
    stage: 'planify',
    round: 1,
    max_rounds: args.max_rounds,
    originalInstruction: args.originalInstruction,
    internalMessages: args.internalMessages,
    tools: args.tools,
    tool_choice: args.tool_choice,
    spec: args.spec,
    activeTypeId: args.spec?.typeId ?? '',
    spawnRetries: 0,
    interpretation: null,
    task: null,
    lastOutput: '',
    lastMessage: '',
    context_window_size: args.context_window_size ?? 0,
    compactPending: false,
    lastUsage: null,
    fellBackToRendered: false,
    accumulatedSteps: [],
    phaseResults: {},
    steering: '',
    pendingAgentId: null,
    decision: null,
    finalOutput: '',
    totalUpstreamCalls: 0,
  };
}
