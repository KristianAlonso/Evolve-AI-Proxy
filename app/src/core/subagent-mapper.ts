// FASE 6 — subagent tool mapping: at the start of the first request (the parent's), the proxy asks
// the model WHICH client tool creates subagents and how its arguments map to (title, type, prompt).
// The model also picks the subagent TYPE for each delegated phase. The result is a
// SubagentSpawnSpec used to emit the spawn ToolCall before every phase.
//
// Fail-safe (never breaks the request): no client tools -> null without any upstream call; a
// malformed mapping answer or a tool name that does not exist in the client's tools -> null after
// 2 attempts, so routes fall back to the current inline agent-loop behavior.

import type { ChatProvider } from '../provider/types.js';
import type { ToolChoice, ToolDefinition, UpstreamMessage } from '../types.js';
import type { TraceLogger } from '../logger.js';
import { DELEGATED_PHASES, parseSpawnSpec, type SubagentSpawnSpec } from './subagent-spawn.js';

const MAX_ATTEMPTS = 2;

export interface MapSubagentToolOptions {
  model: string | null;
  logger?: TraceLogger;
  traceId?: string;
  abort_signal?: AbortSignal;
  max_tokens?: number;
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
    'Do NOT explain or reason in your output. Reply with ONLY the JSON object (no prose, no markdown) of EXACTLY this shape:',
    '{"tool_name":"<the subagent-creating tool>","arg_mapping":{"title":"<argument name for the subagent title>","type":"<argument name for the subagent type>","prompt":"<argument name for the subagent prompt/instruction>"},"phase_types":{"planify":"<subagent type id to use for planning tasks>","execute":"<subagent type id to use for execution tasks>","evaluate":"<subagent type id to use for evaluation tasks>"}}',
    'Use subagent type ids that actually appear in the tool argument [enum: ...] lists when present.',
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
      return JSON.stringify({
        name: t.function.name,
        description: (t.function.description ?? '').slice(0, 300).replace(/\s+/g, ' '),
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
        // Generous: reasoning models spend most of the budget thinking before emitting the (small) JSON answer.
        max_tokens: options.max_tokens ?? 8192,
        logger: options.logger,
        trace_id: options.traceId,
        abort_signal: options.abort_signal,
      });
      const spec = parseSpawnSpec(result.content ?? '', names);
      if (spec) {
        options.logger?.info(
          `subagent mapping: tool="${spec.toolName}" args={title:${spec.argMapping.title},type:${spec.argMapping.type},prompt:${spec.argMapping.prompt}} ` +
          `phase_types={${DELEGATED_PHASES.map((p) => `${p}:${spec.phaseTypes[p]}`).join(',')}} (attempt ${attempt})`,
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
