// FASE 6 — subagent spawn contract: the envelope that binds a subagent request to its parent
// session, and the class that captures the shape of the client's subagent-spawn tool so the
// proxy can call it at the start of every phase.
//
// The spawn tool's prompt is ALWAYS:
//   line 1: the envelope JSON  {"phase":"planify","parent_session_id":"S1","agent_id":"agent-x3"}
//   line 2: blank
//   line 3+: the description of the current task
//
// `agent_id` is minted by the proxy BEFORE the tool call and travels ONLY inside the envelope —
// it is never passed as a tool argument (the envelope in the prompt is the single source of truth
// to re-link the subagent's incoming request to its phase).

import type { ToolCall, ToolDefinition, UpstreamMessage } from './types.js';

/** The three phases that run inside delegated subagents (everything except `interpret`, which
 *  runs in the parent request). */
export const DELEGATED_PHASES = ['planify', 'execute', 'evaluate'] as const;
export type DelegatedPhase = (typeof DELEGATED_PHASES)[number];

/** First-line JSON of a subagent spawn prompt. */
export interface SpawnEnvelope {
  phase: DelegatedPhase;
  parent_session_id: string;
  agent_id: string;
}

export interface SubagentTypeOption {
  id: string;
  description: string;
}

/**
 * The class that determines the shape of the client's subagent-spawn tool (FASE 6 mapping phase):
 * which tool to call, which argument names carry the title / type / prompt, and the pool of
 * subagent types the client tool can launch. `agent_id` is deliberately NOT part of the mapping —
 * it never travels as a tool argument.
 */
export interface SubagentSpawnSpec {
  /** The client tool that creates a subagent (must exist in the tools the client sent). */
  toolName: string;
  /** Argument names (per the tool's own schema) for each spawn parameter. */
  argMapping: { title: string; type: string; prompt: string };
  /**
   * Every subagent type the client tool can launch (ordered most general-purpose first). Used for
   * failover: when the active type never yields a phase result, the orchestrator rotates to the
   * next available one.
   */
  availableTypes: SubagentTypeOption[];
  /**
   * The single subagent type used for EVERY delegated phase. Validated to exist in
   * `availableTypes` (the model may only pick types that actually exist). Sticky for the session;
   * rotated by the orchestrator only on failure.
   */
  typeId: string;
}

/** Mint a proxy-side agent id (travelled only inside the envelope prompt). */
export function newAgentId(): string {
  return `agent-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Build the spawn tool's prompt body: line 1 = envelope JSON, line 2 = blank, then the task. */
export function buildSpawnPrompt(envelope: SpawnEnvelope, taskDescription: string): string {
  return `${JSON.stringify(envelope)}\n\n${taskDescription}`;
}

export interface SpawnEnvelopeDetection {
  envelope: SpawnEnvelope;
  /** Index (in `messages`) of the message carrying the envelope — used for continuation detection. */
  index: number;
}

/**
 * Detect a subagent spawn request: scan the incoming conversation for a message whose FIRST line
 * parses as an envelope with all three required string fields. Returns null for any request that
 * is not a subagent spawn (normal parent / standalone requests).
 */
export function parseSubagentEnvelope(messages: UpstreamMessage[]): SpawnEnvelopeDetection | null {
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (typeof message.content !== 'string') continue;
    const firstLine = message.content.split('\n', 1)[0].trim();
    if (!firstLine.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(firstLine) as Record<string, unknown>;
      if (
        typeof parsed.phase === 'string' &&
        typeof parsed.parent_session_id === 'string' &&
        typeof parsed.agent_id === 'string' &&
        (DELEGATED_PHASES as readonly string[]).includes(parsed.phase)
      ) {
        return {
          envelope: {
            phase: parsed.phase as DelegatedPhase,
            parent_session_id: parsed.parent_session_id,
            agent_id: parsed.agent_id,
          },
          index: i,
        };
      }
    } catch {
      /* first line was not JSON — keep scanning (never crash on client input) */
    }
  }
  return null;
}

/**
 * A subagent may make several LLM calls inside its own session (its internal agent loop). Only the
 * FIRST request (the spawn prompt is the last thing in the conversation) is a "run the phase from
 * the parent's state" request; every later request (assistant/tool turns after the spawn prompt)
 * is a continuation that the proxy serves as a normal request, and whose final content updates the
 * parent's phase result (last content wins).
 */
export function isSubagentContinuation(messages: UpstreamMessage[], spawnIndex: number): boolean {
  return messages.slice(spawnIndex + 1).some((m) => m.role === 'assistant' || m.role === 'tool');
}

/**
 * Build the ToolCall for the spawn delegation. Arguments are taken EXCLUSIVELY from the
 * `argMapping` (title/type/prompt) — the envelope's `agent_id` is embedded in the prompt text and
 * is never a standalone argument, even if the underlying tool schema happens to have an id field.
 */
export function buildSpawnToolCall(
  spec: SubagentSpawnSpec,
  envelope: SpawnEnvelope,
  taskDescription: string,
  title?: string,
  typeId?: string,
): ToolCall {
  if (!spec.argMapping || !spec.argMapping.title || !spec.argMapping.type || !spec.argMapping.prompt) {
    throw new Error('SubagentSpawnSpec.argMapping is incomplete — cannot build the spawn tool call');
  }
  const args: Record<string, unknown> = {
    [spec.argMapping.title]: title ?? envelope.phase,
    [spec.argMapping.type]: typeId ?? spec.typeId,
    [spec.argMapping.prompt]: buildSpawnPrompt(envelope, taskDescription),
  };
  return {
    id: `spawn_${envelope.agent_id}`,
    type: 'function',
    function: { name: spec.toolName, arguments: JSON.stringify(args) },
  };
}

/** Validate a raw model mapping answer (JSON) against the client's actual tools. Null = fail-safe. */
export function parseSpawnSpec(
  raw: string,
  clientToolNames: readonly string[],
): SubagentSpawnSpec | null {
  let parsed: Record<string, unknown>;
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
    parsed = JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const toolName = typeof parsed.tool_name === 'string' ? parsed.tool_name : null;
  // No-subagent-tool answer ({"none":true}) or unknown tool -> no spec.
  if (!toolName || (parsed as { none?: unknown }).none === true) return null;
  if (!clientToolNames.includes(toolName)) return null;

  const mapping = parsed.arg_mapping as Record<string, unknown> | undefined;
  if (
    !mapping ||
    typeof mapping.title !== 'string' || mapping.title === '' ||
    typeof mapping.type !== 'string' || mapping.type === '' ||
    typeof mapping.prompt !== 'string' || mapping.prompt === ''
  ) return null;

  // Every subagent type the tool can launch (failover candidates), ordered most general-purpose
  // first. At least one is mandatory; duplicate ids are collapsed (first one wins).
  const rawTypes = Array.isArray(parsed.subagent_types) ? parsed.subagent_types : null;
  if (!rawTypes || rawTypes.length === 0) return null;
  const availableTypes: SubagentTypeOption[] = [];
  const seen = new Set<string>();
  for (const entry of rawTypes) {
    if (!entry || typeof entry !== 'object') return null;
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== 'string' || id.trim() === '') return null;
    if (seen.has(id.trim())) continue;
    seen.add(id.trim());
    const description = (entry as { description?: unknown }).description;
    availableTypes.push({ id: id.trim(), description: typeof description === 'string' ? description : '' });
  }

  // HARD CONSTRAINT: the chosen type MUST exist in the available list.
  const typeId = typeof parsed.type_id === 'string' ? (parsed.type_id as string).trim() : '';
  if (!availableTypes.some((t) => t.id === typeId)) return null;


  return {
    toolName,
    argMapping: { title: mapping.title, type: mapping.type, prompt: mapping.prompt },
    availableTypes,
    typeId,
  };
}

/**
 * Deterministic (no model involved) detection of a subagent-type list drift between requests.
 * The client may change the list of subagent types it offers between requests (or even rename the
 * spawn tool itself): the only machine-readable source of that list is the `enum` of the spawn
 * tool's type argument in the incoming `tools` schema, so the check needs no upstream call.
 *
 * Returns TRUE (drift: none of the previously mapped types exists in the current request — the
 * caller should re-run the mapping) when:
 *   - the spawn tool is no longer offered at all, OR
 *   - the type argument carries a real `enum` and NONE of `spec.availableTypes` ids appears in it.
 *
 * Returns FALSE when the check is inconclusive (the type argument is a free-form string: no enum
 * to read, so the previous types may or may not still exist) or when at least one previously
 * mapped type still exists in the current enum.
 */
export function detectTypeDrift(spec: SubagentSpawnSpec, currentTools: ToolDefinition[]): boolean {
  const tool = currentTools.find((t) => t.function.name === spec.toolName);
  if (!tool) return true; // the spawn tool disappeared — the type list has certainly changed
  const params = tool.function.parameters as { properties?: Record<string, { enum?: string[] }> } | undefined;
  const enumVals = params?.properties?.[spec.argMapping.type]?.enum;
  if (!Array.isArray(enumVals) || enumVals.length === 0) return false; // free-form: cannot detect without the model
  const current = enumVals.map((v) => String(v));
  return !spec.availableTypes.some((t) => current.includes(t.id));
}
