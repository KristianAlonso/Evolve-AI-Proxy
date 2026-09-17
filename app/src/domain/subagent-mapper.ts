// FASE 6 — subagent tool mapping: at the start of the first request (the parent's), the proxy asks
// the model WHICH client tool creates subagents, how its arguments map to (title, type, prompt),
// and to list EVERY subagent type that tool can launch (id + description, most general first).
// The model then picks ONE general-purpose type (it MUST exist in its own list; when the type
// argument has a real enum in the client schema, every listed id is hard-validated against it).
// The result is a SubagentSpawnSpec: the orchestrator uses spec.typeId for every spawn and walks
// spec.availableTypes as failover candidates when the active type never yields a phase result.
//
// Fail-safe (never breaks the request): no client tools -> null without any upstream call; a
// malformed mapping answer or a tool name that does not exist in the client's tools -> null after
// 2 attempts, so routes fall back to the current inline agent-loop behavior.

import type { ChatProvider } from './provider/types.js';
import type { ToolChoice, ToolDefinition, UpstreamMessage } from './types.js';
import type { TraceLogger } from './logging.js';
import { parseSpawnSpec, type SubagentSpawnSpec } from './subagent-spawn.js';

const MAX_ATTEMPTS = 2;

/**
 * HARD existence check: when the mapped type argument has a real `enum` in the client tool's
 * schema, every id listed in the spec (and therefore the chosen one too) MUST be one of those
 * enum values — the model can never invent a subagent type. Returns false when the spec names a
 * type the client tool cannot actually launch.
 */
function specTypesExistInClient(spec: SubagentSpawnSpec, clientTools: ToolDefinition[]): boolean {
  const tool = clientTools.find((t) => t.function.name === spec.toolName);
  const params = tool?.function.parameters as { properties?: Record<string, { enum?: string[] }> } | undefined;
  const enumVals = params?.properties?.[spec.argMapping.type]?.enum;
  if (!Array.isArray(enumVals) || enumVals.length === 0) return true; // free-form: trust the model's list
  const allowed = enumVals.map((v) => String(v));
  return spec.availableTypes.every((t) => allowed.includes(t.id));
}

export interface MapSubagentToolOptions {
  model: string | null;
  logger?: TraceLogger;
  traceId?: string;
  abort_signal?: AbortSignal;
  /** ADR A-007 (passthrough-intacto): the client's request parameters, forwarded as-is. */
  passthrough?: Record<string, unknown>;
}

/** Ask the model to identify the subagent-spawn tool among the client's tools and map its args. */
export async function mapSubagentTool(
  provider: ChatProvider,
  clientTools: ToolDefinition[],
  options: MapSubagentToolOptions,
): Promise<SubagentSpawnSpec | null> {
  if (!clientTools || clientTools.length === 0) return null;

  const system = [
    'You are the tool mapper of an agent-loop proxy.',
    'The client offers the function tools listed below (compact JSON: name, description, and argument names; some arguments list their allowed values in [enum: ...]). One of them creates subagents —',
    'it may be called spawn, subagent, task, agent, delegate or similar — and takes at least a',
    'title, a subagent type, and a prompt/instruction.',
    'Identify that tool, map its arguments, and list ALL the subagent types it can launch: every',
    'type id together with a one-line description, ordered from the MOST general/simple/all-purpose',
    'type to the most specialized ones.',
    'When the subagent type argument has an [enum: ...] list, the ids in "subagent_types" MUST all',
    'come from that list (include every value it offers). When it has no enum, list the type ids',
    'that the tool or argument description mentions; if you cannot establish any, list exactly one',
    'entry: {"id":"default","description":"default"}.',
    'Then pick ONE subagent type to be used for EVERY delegated phase: the most general, simple,',
    'all-purpose type available (a generic "task"/"general"/"default"/"plain"/"standard" type). Do',
    'NOT pick a specialized or role-specific agent type (coder, reviewer, planner, researcher,',
    'explorer, critic, ...) unless no general-purpose type exists; in that case pick the single most',
    'appropriate type to handle planning, execution and evaluation alike. The chosen type MUST be',
    'one of the ids you listed in "subagent_types".',
    'Do NOT explain or reason in your output. Reply with ONLY the JSON object (no prose, no markdown) of EXACTLY this shape:',
    '{"tool_name":"<the subagent-creating tool>","arg_mapping":{"title":"<argument name for the subagent title>","type":"<argument name for the subagent type>","prompt":"<argument name for the subagent prompt/instruction>"},"subagent_types":[{"id":"<type id>","description":"<one line>"}],"type_id":"<the one chosen type id>"}',
    'If NO tool creates subagents, reply with exactly: {"none":true}',
  ].join('\n');

  const user = `Client tools (compact JSON):\n${clientTools
    .map((t) => {
      const params = t.function.parameters as { properties?: Record<string, { description?: string; enum?: string[] }> } | undefined;
      const props = (params?.properties ?? {}) as Record<string, { description?: string; enum?: string[] }>;
      const args: Record<string, string> = {};
      for (const [key, schema] of Object.entries(props)) {
        const desc = typeof schema?.description === 'string' ? schema.description.slice(0, 120).replace(/\s+/g, ' ') : '';
        const enumVals = Array.isArray(schema?.enum) ? `[enum: ${schema.enum.map((v) => String(v)).join(' | ')}]` : '';
        args[key] = [desc, enumVals].filter(Boolean).join(' ');
      }
      // Spawn-like tools (task/spawn/subagent/agent/...) often list their valid subagent types in a
      // LONG description tail (e.g. opencode's built-in task tool: "Available agent types: ..."),
      // which a blind 300-char truncation would hide — then the model falls back to inventing
      // "default" and the client rejects it at runtime. Keep those descriptions (capped) intact.
      const spawnLike = /task|spawn|subagent|agent|delegate|worker|launch/i.test(t.function.name);
      const descCap = spawnLike ? 4000 : 300;
      return JSON.stringify({
        name: t.function.name,
        description: (t.function.description ?? '').slice(0, descCap).replace(/\s+/g, ' '),
        arguments: args,
      });
    })
    .join('\n')}`;

  const messages: UpstreamMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  const names = clientTools.map((t) => t.function.name);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await provider.complete(options.model, messages, {
        // ADR A-007 (passthrough-intacto): no invented max_tokens budget — the client's request
        // parameters (temperature, max_tokens, ...) are forwarded exactly as sent; no client value
        // means no field in the upstream call.
        passthrough: options.passthrough,
        logger: options.logger,
        trace_id: options.traceId,
        abort_signal: options.abort_signal,
      });
      let spec = parseSpawnSpec(result.content ?? '', names);
      if (spec && !specTypesExistInClient(spec, clientTools)) {
        options.logger?.warn(
          `subagent mapping attempt ${attempt}: rejected — mapped subagent types are not in the client tool's type enum`,
        );
        spec = null;
      }
      if (spec) {
        options.logger?.info(
          `subagent mapping: tool="${spec.toolName}" args={title:${spec.argMapping.title},type:${spec.argMapping.type},prompt:${spec.argMapping.prompt}} ` +
          `type="${spec.typeId}" available=[${spec.availableTypes.map((t) => t.id).join(',')}] (attempt ${attempt})`,
        );
        return spec;
      }
      options.logger?.warn(`subagent mapping attempt ${attempt}: no valid spec (model answered but no usable subagent tool mapping)`);
    } catch (err) {
      options.logger?.warn(`subagent mapping attempt ${attempt} failed: ${String(err)}`);
    }
  }
  options.logger?.warn('subagent mapping failed after retries — falling back to inline agent loop (no subagent delegation)');
  return null;
}
