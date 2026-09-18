// FASE 6 — question-tool mapping: detect (via the model) whether the client offers a tool that
// asks the USER something interactively (e.g. OpenCode's `question`), and map its arguments.
// MIMICS the subagent-spawn mapping (subagent-mapper.ts): the same model-based approach, the
// same options shape, the same `provider.complete` call, the same retry budget, and the same
// "no such tool → null → fallback" contract. The only difference is the spec shape (a question
// tool has a questions-argument + a batch flag, no type list).
//
// Returns null when the client has no question tool (the orchestrator then falls back to the
// single-question `ASK_USER:` marker / awaiting_user flow).

import type { ChatProvider } from './provider/types.js';
import type { ToolDefinition, UpstreamMessage } from './types.js';
import type { TraceLogger } from './logging.js';
import { clientToolNames, parseQuestionSpec, type QuestionToolSpec } from './question-tool.js';

const MAX_ATTEMPTS = 2;

export interface MapQuestionToolOptions {
  model: string | null;
  logger?: TraceLogger;
  traceId?: string;
  abort_signal?: AbortSignal;
  passthrough?: Record<string, unknown>;
}

const SYSTEM_PROMPT = `You are the question tool mapper of an agent-loop proxy. The client gives you the list of tools
it offers. Your only job: find the ONE tool whose purpose is to ask the USER (a human) something
interactively — a question, a decision, a confirmation, a choice (e.g. a "question", "ask_user" or
"clarify" tool). You will answer with strict JSON only. Do not add any other text.

Return the tool's JSON schema verbatim as a "tool" entry (the client will use it to route the
proxy's call). Also report which of its arguments carries the questions, and whether that argument
accepts an ARRAY (batch — several questions at once) or a single object/string (one at a time).

Output, strict JSON (no markdown, no prose):
{"tool": <the tool's schema object>, "tool_name": "<tool name>", "questions_arg": "<argument name that carries the questions>", "batch": <true|false>}

If the client offers NO tool that asks the user something, answer exactly: {"none": true}

RULES:
- There is at most ONE question tool. If the client has several candidates, pick the best fit.
- NEVER invent a tool name that is not in the list.
- NEVER invent an argument name that is not in the tool's parameters.`;

function buildUserMessage(clientTools: ToolDefinition[]): string {
  const names = clientToolNames(clientTools);
  const list = clientTools
    .map((t) => {
      const schema = JSON.stringify(t.function.parameters ?? {});
      return `- name: ${t.function.name}\n  parameters: ${schema}`;
    })
    .join('\n');
  return `The client offers these tools:
${list}

Which one asks the USER (a human) something interactively? Answer the strict JSON described above
("tool", "tool_name", "questions_arg", "batch"), or {"none": true} if there is none.
${names.length === 0 ? 'There are no tools, so answer {"none": true}.' : ''}`;
}

export async function mapQuestionTool(
  provider: ChatProvider,
  clientTools: ToolDefinition[],
  options: MapQuestionToolOptions,
): Promise<QuestionToolSpec | null> {
  const names = clientToolNames(clientTools);
  const system = SYSTEM_PROMPT;
  const user = buildUserMessage(clientTools);
  const messages: UpstreamMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = await provider.complete(options.model, messages, {
      passthrough: options.passthrough,
      logger: options.logger,
      trace_id: options.traceId,
      abort_signal: options.abort_signal,
    });
    const raw = result.content ?? '';
    if (raw.includes('"none"')) {
      options.logger?.info(`question mapping: no question tool available (attempt ${attempt})`);
      return null;
    }
    const spec = parseQuestionSpec(raw, names);
    if (spec) {
      options.logger?.info(
        `question mapping: tool="${spec.toolName}" questions_arg="${spec.questionsArg}" batch=${spec.batch} (attempt ${attempt})`,
      );
      return spec;
    }
    options.logger?.warn(`question mapping attempt ${attempt} returned invalid spec; ${attempt < MAX_ATTEMPTS ? 'retrying' : 'falling back to single-question mode'}`);
  }
  return null;
}
