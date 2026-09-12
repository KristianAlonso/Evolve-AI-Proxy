// FASE 6 — serializable agent-loop state. Lives inside the parent SessionStore entry so the
// orchestrator can be RESUMED across independent HTTP requests:
//
//   1) parent first request  -> interpret + spawn(planify)
//   2) subagent request(s)   -> run the phase, store `phaseResults[agent_id]`
//   3) parent resume request -> consume the result, spawn the next phase (or finish)
//
// Every field must be plain JSON (SessionStore serializes it for TTL bookkeeping).

import type { AgentTask, LoopDecision, ToolChoice, ToolDefinition, UpstreamMessage } from '../types.js';
import type { Interpretation } from './interpreter.js';
import type { ContextStep } from './context-manager.js';
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
   * rotated to the next `spec.availableTypes` entry when the active type keeps failing, and pinned
   * for the rest of the session once it yields a phase result).
   */
  activeTypeId: string;
  /** Consecutive spawn re-emissions of the pending phase without a result (failover counter). */
  spawnRetries: number;
  interpretation: Interpretation | null;
  /** The current AgentTask for the round (set after the planify phase result is consumed). */
  task: AgentTask | null;
  /** Latest execute-phase output. */
  lastOutput: string;
  accumulatedSteps: ContextStep[];
  /** agent_id -> last content of that subagent (the canonical phase result). */
  phaseResults: Record<string, string>;
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
    accumulatedSteps: [],
    phaseResults: {},
    pendingAgentId: null,
    decision: null,
    finalOutput: '',
    totalUpstreamCalls: 0,
  };
}
