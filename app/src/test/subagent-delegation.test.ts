// FASE 6 — subagent phase delegation: unit tests for the spawn contract, the tool mapper and the
// orchestrator state machine. No network — every provider is a local stub.

import { describe, expect, it } from 'vitest';
import { createLogger, type TraceLogger } from '../infrastructure/logger.js';
import type { ProviderCallOptions } from '../domain/provider/types.js';
import type { NormalizedResult } from '../domain/types.js';
import type { ToolCall, ToolDefinition, UpstreamMessage } from '../domain/types.js';
import {
  buildSpawnPrompt,
  buildSpawnToolCall,
  detectTypeDrift,
  isSubagentContinuation,
  newAgentId,
  parseSpawnSpec,
  parseSubagentEnvelope,
  type SpawnEnvelope,
  type SubagentSpawnSpec,
} from '../domain/subagent-spawn.js';
import { mapSubagentTool } from '../domain/subagent-mapper.js';
import { mapQuestionTool } from '../domain/question-mapper.js';
import {
  buildQuestionToolCall,
  clientToolNames,
  findQuestionAnswer,
  parseAskUserQuestions,
  parseQuestionSpec,
  type QuestionToolSpec,
} from '../domain/question-tool.js';
import { extractAskUser } from '../domain/phase-prompts.js';
import { SubagentOrchestrator, type OrchestratorOutcome } from '../domain/orchestrator.js';
import { newLoopState, type LoopStateData } from '../domain/loop-state.js';
import { stub } from './stub-provider.js';

const log: TraceLogger = createLogger('test');

const VALID_SPEC_JSON = JSON.stringify({
  tool_name: 'task',
  arg_mapping: { title: 'description', type: 'subagent_type', prompt: 'prompt' },
  subagent_types: [
    { id: 'plan', description: 'Plans work' },
    { id: 'build', description: 'Builds things' },
    { id: 'critic', description: 'Evaluates results' },
  ],
  type_id: 'plan',
});

const SPAWN_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'task',
    description: 'Launch a new agent to handle a task.',
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string' },
        subagent_type: { type: 'string', enum: ['plan', 'build', 'critic'] },
        prompt: { type: 'string' },
      },
    },
  },
};

const OTHER_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read a file.',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
  },
};

// The client's interactive question tool (OpenCode's `question`): one `questions` argument that
// accepts an ARRAY of question objects — i.e. the client can be asked several questions at once.
const QUESTION_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'question',
    description: 'Ask the user a question (one or several at once).',
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string' },
              options: { type: 'array', items: { type: 'object' } },
            },
            required: ['question'],
          },
        },
      },
      required: ['questions'],
    },
  },
};

// What the model reports for the question-tool mapping (batch-capable `question` tool).
const QUESTION_SPEC_JSON = JSON.stringify({
  tool: QUESTION_TOOL,
  tool_name: 'question',
  questions_arg: 'questions',
  batch: true,
});

const envelope: SpawnEnvelope = {
  phase: 'planify',
  parent_session_id: 'ses_parent_1',
  agent_id: 'agent-abc123',
};

describe('subagent spawn contract', () => {
  it('buildSpawnPrompt: line 1 = envelope JSON, line 2 blank, line 3+ = task', () => {
    const prompt = buildSpawnPrompt(envelope, 'Plan the next task.');
    const lines = prompt.split('\n');
    expect(JSON.parse(lines[0])).toEqual(envelope);
    expect(lines[1]).toBe('');
    expect(lines.slice(2).join('\n')).toBe('Plan the next task.');
  });

  it('parseSubagentEnvelope finds the envelope with its index', () => {
    const messages: UpstreamMessage[] = [
      { role: 'user', content: 'something earlier', reasoning: '', tool_calls: [] },
      { role: 'user', content: buildSpawnPrompt(envelope, 'Plan the next task.'), reasoning: '', tool_calls: [] },
    ];
    const found = parseSubagentEnvelope(messages);
    expect(found).not.toBeNull();
    expect(found!.envelope).toEqual(envelope);
    expect(found!.index).toBe(1);
  });

  it('parseSubagentEnvelope returns null for normal requests and bad envelopes', () => {
    expect(parseSubagentEnvelope([{ role: 'user', content: 'just a question', reasoning: '', tool_calls: [] }])).toBeNull();
    // JSON first line but not an envelope
    expect(
      parseSubagentEnvelope([{ role: 'user', content: '{"foo": 1}\n\nreal task', reasoning: '', tool_calls: [] }]),
    ).toBeNull();
    // envelope with an unknown phase
    const bad = `{"phase":"interpret","parent_session_id":"S","agent_id":"a"}\n\nx`;
    expect(parseSubagentEnvelope([{ role: 'user', content: bad, reasoning: '', tool_calls: [] }])).toBeNull();
  });

  it('isSubagentContinuation: false on the first request, true once an assistant/tool turn follows', () => {
    const first: UpstreamMessage[] = [{ role: 'user', content: buildSpawnPrompt(envelope, 'Plan.'), reasoning: '', tool_calls: [] }];
    expect(isSubagentContinuation(first, 0)).toBe(false);
    const withAssistant: UpstreamMessage[] = [
      ...first,
      { role: 'assistant', content: 'planning done', reasoning: '', tool_calls: [] },
      { role: 'user', content: 'and now?', reasoning: '', tool_calls: [] },
    ];
    expect(isSubagentContinuation(withAssistant, 0)).toBe(true);
    const withToolResult: UpstreamMessage[] = [
      ...first,
      { role: 'tool', content: 'ok', tool_call_id: 't', reasoning: '', tool_calls: [] },
    ];
    expect(isSubagentContinuation(withToolResult, 0)).toBe(true);
  });

  it('buildSpawnToolCall: args come only from argMapping; agent_id never travels as an argument', () => {
    const spec: SubagentSpawnSpec = {
      toolName: 'task',
      argMapping: { title: 'description', type: 'subagent_type', prompt: 'prompt' },
      availableTypes: [{ id: 'plan', description: 'Plans work' }],
      typeId: 'plan',
    };
    const call = buildSpawnToolCall(spec, envelope, 'Plan the next task.', 'planify (round 1)');
    expect(call.id).toBe('spawn_agent-abc123');
    expect(call.function.name).toBe('task');
    const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
    expect(Object.keys(args).sort()).toEqual(['description', 'prompt', 'subagent_type'].sort());
    expect(args.description).toBe('planify (round 1)');
    expect(args.subagent_type).toBe('plan'); // the single active type (spec.typeId)
    // An explicit type override (failover) wins over spec.typeId.
    const rotated = buildSpawnToolCall(spec, envelope, 'Plan the next task.', 'planify (round 1)', 'build');
    expect(JSON.parse(rotated.function.arguments).subagent_type).toBe('build');
    // The envelope (with agent_id) is embedded in the prompt text...
    const promptArg = String(args.prompt);
    expect(JSON.parse(promptArg.split('\n', 1)[0])).toEqual(envelope);
    // ...and the raw agent id never appears as its own argument value.
    expect(Object.values(args)).not.toContain('agent-abc123');
  });

  it('parseSpawnSpec: valid answer -> spec; none/unknown/bad -> null', () => {
    const spec = parseSpawnSpec(VALID_SPEC_JSON, ['task', 'read_file']);
    expect(spec).not.toBeNull();
    expect(spec!.toolName).toBe('task');
    expect(spec!.typeId).toBe('plan');
    expect(spec!.availableTypes.map((t) => t.id)).toEqual(['plan', 'build', 'critic']);

    expect(parseSpawnSpec('{"none":true}', ['task'])).toBeNull();
    expect(parseSpawnSpec(VALID_SPEC_JSON, ['read_file'])).toBeNull(); // tool not offered by the client
    expect(parseSpawnSpec('not json at all', ['task'])).toBeNull();
    expect(parseSpawnSpec('```json\n' + VALID_SPEC_JSON + '\n```', ['task'])).not.toBeNull(); // markdown-tolerant
    // missing arg_mapping field -> null
    expect(
      parseSpawnSpec('{"tool_name":"task","arg_mapping":{"title":"a","type":"b"},"subagent_types":[{"id":"x"}],"type_id":"x"}', ['task']),
    ).toBeNull();
    // missing subagent_types -> null
    expect(parseSpawnSpec('{"tool_name":"task","arg_mapping":{"title":"a","type":"b","prompt":"c"},"type_id":"a"}', ['task'])).toBeNull();
    // empty subagent_types -> null
    expect(parseSpawnSpec('{"tool_name":"task","arg_mapping":{"title":"a","type":"b","prompt":"c"},"subagent_types":[],"type_id":"a"}', ['task'])).toBeNull();
    // type_id NOT in the available list -> null (the chosen agent must exist)
    expect(
      parseSpawnSpec('{"tool_name":"task","arg_mapping":{"title":"a","type":"b","prompt":"c"},"subagent_types":[{"id":"x"}],"type_id":"y"}', ['task']),
    ).toBeNull();
  });

  describe('detectTypeDrift (deterministic, no model): type list changed between requests', () => {
    const spec: SubagentSpawnSpec = {
      toolName: 'task',
      argMapping: { title: 'description', type: 'subagent_type', prompt: 'prompt' },
      availableTypes: [
        { id: 'plan', description: '' },
        { id: 'build', description: '' },
      ],
      typeId: 'plan',
    };
    const toolsWithEnum = (ids: string[]): ToolDefinition[] => [
      {
        type: 'function',
        function: {
          name: 'task',
          description: 'Launch a new agent.',
          parameters: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              subagent_type: { type: 'string', enum: ids },
              prompt: { type: 'string' },
            },
          },
        },
      },
    ];

    it('detects drift when the type enum no longer contains ANY previously mapped type', () => {
      expect(detectTypeDrift(spec, toolsWithEnum(['fresh', 'new']))).toBe(true);
    });

    it('no drift when the enum is unchanged or still contains a previously mapped type', () => {
      expect(detectTypeDrift(spec, toolsWithEnum(['plan', 'build']))).toBe(false);
      expect(detectTypeDrift(spec, toolsWithEnum(['build', 'plan', 'extra']))).toBe(false);
      expect(detectTypeDrift(spec, toolsWithEnum(['extra', 'plan']))).toBe(false);
    });

    it('detects drift when the spawn tool disappears from the client tools', () => {
      expect(detectTypeDrift(spec, [])).toBe(true);
      expect(detectTypeDrift(spec, [OTHER_TOOL])).toBe(true);
    });

    it('cannot detect (returns false) when the type argument is free-form (no enum to read)', () => {
      const freeForm: ToolDefinition = {
        type: 'function',
        function: {
          name: 'task',
          description: 'Launch a new agent.',
          parameters: {
            type: 'object',
            properties: { description: { type: 'string' }, subagent_type: { type: 'string' }, prompt: { type: 'string' } },
          },
        },
      };
      expect(detectTypeDrift(spec, [freeForm])).toBe(false);
    });
  });

  it('newAgentId is unique-ish and prefixed', () => {
    const a = newAgentId();
    const b = newAgentId();
    expect(a.startsWith('agent-')).toBe(true);
    expect(a).not.toBe(b);
  });
});

describe('subagent tool mapper', () => {
  it('returns null immediately with no upstream call when the client offers no tools', async () => {
    const provider = stub();
    const spec = await mapSubagentTool(provider, [], { model: 'm' });
    expect(spec).toBeNull();
    expect(provider.calls.length).toBe(0);
  });

  it('asks the model (compact prompt with the tool names) and parses the spec', async () => {
    const provider = withMapping(stub(), VALID_SPEC_JSON);
    const spec = await mapSubagentTool(provider, [SPAWN_TOOL, OTHER_TOOL], { model: 'm', logger: log });
    expect(spec).not.toBeNull();
    expect(spec!.toolName).toBe('task');
    expect(spec!.typeId).toBe('plan');
    expect(spec!.availableTypes.map((t) => t.id)).toEqual(['plan', 'build', 'critic']);
    // The mapping prompt must have seen both tool names (so the model can pick).
    const mappingCall = provider.calls.find((c) => c.messages.some((m) => (m.content ?? '').includes('tool mapper')));
    expect(mappingCall).toBeDefined();
  });

  it('rejects (after retries) a spec whose type ids are not in the client tool type-enum (must exist)', async () => {
    const bogus = JSON.stringify({
      tool_name: 'task',
      arg_mapping: { title: 'description', type: 'subagent_type', prompt: 'prompt' },
      subagent_types: [{ id: 'fancy', description: 'not a real type' }],
      type_id: 'fancy',
    });
    const provider = withMapping(stub(), bogus);
    expect(await mapSubagentTool(provider, [SPAWN_TOOL], { model: 'm', logger: log })).toBeNull();
    expect(provider.calls.length).toBe(2); // both attempts rejected
  });

  it('returns null after retries when the model answers {"none":true} or garbage', async () => {
    const noneProvider = withMapping(stub(), '{"none":true}');
    expect(await mapSubagentTool(noneProvider, [SPAWN_TOOL], { model: 'm', logger: log })).toBeNull();
    expect(noneProvider.calls.length).toBe(2); // one attempt each

    const garbageProvider = withMapping(stub(), 'I cannot decide which tool it is.');
    expect(await mapSubagentTool(garbageProvider, [SPAWN_TOOL], { model: 'm', logger: log })).toBeNull();
    expect(garbageProvider.calls.length).toBe(2);
  });

  it('keeps spawn-like tools\' full descriptions (the type list lives in the long description tail)', async () => {
    // Real-world case (opencode built-in task tool): subagent_type is FREE-FORM and the valid types
    // are listed at the END of the tool description. A blind 300-char truncation hides the list,
    // the model falls back to inventing "default", and the client rejects it at runtime.
    const longDesc =
      'Launch a new agent to handle complex, multistep tasks autonomously. '.repeat(20) +
      'Available agent types: architect, coder, critic, designer, docs, explorer, reviewer, sme, test_engineer';
    const spawnToolWithLongDesc: ToolDefinition = {
      type: 'function',
      function: {
        name: 'task',
        description: longDesc,
        parameters: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            subagent_type: { type: 'string' },
            prompt: { type: 'string' },
          },
        },
      },
    };
    const provider = withMapping(stub(), VALID_SPEC_JSON);
    await mapSubagentTool(provider, [spawnToolWithLongDesc], { model: 'm', logger: log });
    const mappingCall = provider.calls.find((c) => c.messages.some((m) => (m.content ?? '').includes('tool mapper')));
    const userMsg = mappingCall?.messages.find((m) => m.role === 'user');
    expect(userMsg?.content).toContain('Available agent types: architect, coder, critic');

    // Non-spawn tools stay truncated (300 chars) to keep the mapping prompt small.
    const otherLong: ToolDefinition = {
      type: 'function',
      function: {
        name: 'bash',
        description: 'x'.repeat(400),
        parameters: { type: 'object', properties: { command: { type: 'string' } } },
      },
    };
    const p2 = withMapping(stub(), VALID_SPEC_JSON);
    await mapSubagentTool(p2, [spawnToolWithLongDesc, otherLong], { model: 'm', logger: log });
    const call2 = p2.calls.find((c) => c.messages.some((m) => (m.content ?? '').includes('tool mapper')));
    const user2 = call2?.messages.find((m) => m.role === 'user');
    expect(user2?.content?.includes('x'.repeat(301))).toBe(false);
  });
});

/** Wrap a stub provider so the tool-mapper prompt gets a canned answer. */
function withMapping(base: ReturnType<typeof stub>, answer: string) {
  const wrapped = {
    ...base,
    async complete(model: string | null, messages: UpstreamMessage[], options?: ProviderCallOptions): Promise<NormalizedResult> {
      const combined = messages.map((m) => m.content ?? '').join('\n');
      if (combined.includes('tool mapper')) {
        base.calls.push({ model, messages });
        return { content: answer, reasoning: '', tool_calls: [], refused: false, finish_reason: 'stop', raw: {} };
      }
      return base.complete(model, messages, options);
    },
  };
  return wrapped;
}

// Routes the two MAPPING calls (subagent-spawn + question) to fixed JSON answers, and lets every
// other call (interpret) fall through to the stub router. The question mapper is matched FIRST
// (its system prompt says "question tool mapper", which also contains "tool mapper").
function withBothMappings(
  base: ReturnType<typeof stub>,
  spawnAnswer: string,
  questionAnswer: string,
) {
  const wrapped = {
    ...base,
    async complete(model: string | null, messages: UpstreamMessage[], options?: ProviderCallOptions): Promise<NormalizedResult> {
      const combined = messages.map((m) => m.content ?? '').join('\n');
      if (combined.includes('question tool mapper')) {
        base.calls.push({ model, messages });
        return { content: questionAnswer, reasoning: '', tool_calls: [], refused: false, finish_reason: 'stop', raw: {} };
      }
      if (combined.includes('tool mapper')) {
        base.calls.push({ model, messages });
        return { content: spawnAnswer, reasoning: '', tool_calls: [], refused: false, finish_reason: 'stop', raw: {} };
      }
      return base.complete(model, messages, options);
    },
  };
  return wrapped;
}

function makeState(overrides: Partial<LoopStateData> = {}): LoopStateData {
  const state = newLoopState({
    originalInstruction: 'Do the thing',
    internalMessages: [{ role: 'user', content: 'Do the thing', reasoning: '', tool_calls: [] }],
    max_rounds: 2,
    tools: [SPAWN_TOOL],
    spec: null,
  });
  state.spec = {
    toolName: 'task',
    argMapping: { title: 'description', type: 'subagent_type', prompt: 'prompt' },
    availableTypes: [
      { id: 'plan', description: 'Plans work' },
      { id: 'build', description: 'Builds things' },
      { id: 'critic', description: 'Evaluates results' },
    ],
    typeId: 'plan',
  };
  state.activeTypeId = state.spec.typeId; // start() normally does this after the mapping
  return { ...state, ...overrides };
}

describe('subagent orchestrator', () => {
  it('start(): maps the tool, interprets, and emits the planify spawn ToolCall', async () => {
    const provider = withMapping(stub(), VALID_SPEC_JSON);
    const orchestrator = new SubagentOrchestrator(provider, log);
    const state = makeState();
    let sinkCreated = false;
    const out = await orchestrator.start({
      state,
      sessionId: 'ses_parent_1',
      model: 'm',
      makeSink: () => {
        sinkCreated = true;
        return undefined;
      },
    });
    expect(out).not.toBeNull();
    const outcome: OrchestratorOutcome = out!.outcome;
    expect(outcome.kind).toBe('tool_call');
    expect(outcome.decision).toBe('tool_calls_pending');
    expect(outcome.toolCall).toBeDefined();
    const args = JSON.parse(outcome.toolCall!.function.arguments) as Record<string, unknown>;
    expect(outcome.toolCall!.function.name).toBe('task');
    const env = JSON.parse(String(args.prompt).split('\n', 1)[0]) as SpawnEnvelope;
    // The delegation gate of clients like OpenCode+opencode-swarm blocks any dispatch without a
    // non-empty ACCEPTANCE line — the spawn prompt must carry one (per-stage, in the task part).
    expect(String(args.prompt)).toMatch(/ACCEPTANCE: DONE when/);
    expect(env.phase).toBe('planify');
    expect(env.parent_session_id).toBe('ses_parent_1');
    expect(state.pendingAgentId).toBe(env.agent_id);
    expect(state.stage).toBe('planify');
    expect(state.spec).not.toBeNull();
    expect(state.activeTypeId).toBe('plan'); // pinned from spec.typeId at start
    expect(sinkCreated).toBe(true);
    expect(state.totalUpstreamCalls).toBe(3); // spawn-mapping + question-mapping + interpret
  });

  it('start(): returns null (and never creates a sink) when the mapping finds no subagent tool', async () => {
    const provider = withMapping(stub(), '{"none":true}');
    const orchestrator = new SubagentOrchestrator(provider, log);
    const state = makeState();
    let sinkCreated = false;
    const out = await orchestrator.start({
      state,
      sessionId: 'ses_parent_1',
      model: 'm',
      makeSink: () => {
        sinkCreated = true;
        return undefined;
      },
    });
    expect(out).toBeNull();
    expect(sinkCreated).toBe(false);
  });

  it('resume(): walks planify -> execute -> evaluate -> done and emits a spawn per stage', () => {
    const orchestrator = new SubagentOrchestrator(stub(), log);
    const state = makeState();
    state.pendingAgentId = 'agent-p1';
    state.phaseResults['agent-p1'] = JSON.stringify({ description: 'Take a concrete step' });

    // planify consumed -> spawn execute (the fresh agent id rides in the ToolCall id and
    // in state.pendingAgentId — the OLD one was consumed).
    const out1 = orchestrator.resume(state, 'ses_parent_1');
    expect(out1.kind).toBe('tool_call');
    expect(out1.toolCall!.id).toBe(`spawn_${state.pendingAgentId}`);
    // The SAME single type is used for every phase (state.activeTypeId = spec.typeId).
    expect(JSON.parse(out1.toolCall!.function.arguments).subagent_type).toBe('plan');
    expect(state.stage).toBe('execute');
    expect(state.task!.description).toBe('Take a concrete step');

    // Every spawn (every stage) carries the ACCEPTANCE line required by client delegation gates.
    const spawnPrompt = (out: OrchestratorOutcome): string =>
      String(JSON.parse(out.toolCall!.function.arguments).prompt);
    expect(spawnPrompt(out1)).toMatch(/ACCEPTANCE: DONE when/); // execute

    // execute consumed -> evaluate with the accumulated step
    const execAgentId = state.pendingAgentId!;
    state.phaseResults[execAgentId] = 'Output A';
    const out2 = orchestrator.resume(state, 'ses_parent_1');
    expect(out2.kind).toBe('tool_call');
    expect(state.stage).toBe('evaluate');
    expect(state.lastOutput).toBe('Output A');
    expect(state.accumulatedSteps.length).toBe(1);
    expect(state.accumulatedSteps[0].output).toBe('Output A');
    expect(spawnPrompt(out2)).toMatch(/ACCEPTANCE: DONE when/); // evaluate

    // evaluate "continue" with round < max_rounds -> next round planify
    const evalAgentId = state.pendingAgentId!;
    state.phaseResults[evalAgentId] = '{"outcome":"still working"}';
    const out3 = orchestrator.resume(state, 'ses_parent_1');
    expect(out3.kind).toBe('tool_call');
    expect(state.stage).toBe('planify');
    expect(state.round).toBe(2);
    expect(spawnPrompt(out3)).toMatch(/ACCEPTANCE: DONE when/); // planify (round 2)

    // Walk round 2 quickly: planify -> execute -> evaluate(complete) -> final.
    const deliver = (content: string) => {
      state.phaseResults[state.pendingAgentId!] = content;
    };
    deliver('Take another step');
    let out = orchestrator.resume(state, 'ses_parent_1'); // -> spawn execute (round 2)
    expect(out.kind).toBe('tool_call');
    deliver('Final output');
    out = orchestrator.resume(state, 'ses_parent_1'); // -> spawn evaluate (round 2)
    expect(out.kind).toBe('tool_call');
    deliver('{"complete": true}');
    out = orchestrator.resume(state, 'ses_parent_1'); // -> final
    expect(out.kind).toBe('final');
    expect(out.decision).toBe('complete');
    expect(out.finalOutput).toBe('Final output');
    expect(state.stage).toBe('done');
  });

  it('resume(): evaluator awaiting_user pauses the loop (final = the question, state preserved) and the user reply resumes at planify (round+1, steering)', () => {
    const orchestrator = new SubagentOrchestrator(stub(), log);
    const state = makeState();
    state.pendingAgentId = 'agent-p1';
    state.phaseResults['agent-p1'] = JSON.stringify({ description: 'Gather brand preferences' });

    let out = orchestrator.resume(state, 'ses_parent_1'); // planify consumed -> spawn execute
    expect(out.kind).toBe('tool_call');

    // The execute-phase output IS the question posed to the human.
    state.phaseResults[state.pendingAgentId!] = 'What brand should we use?';
    out = orchestrator.resume(state, 'ses_parent_1'); // -> spawn evaluate
    expect(out.kind).toBe('tool_call');
    expect(state.stage).toBe('evaluate');

    // The evaluator flags the question: the loop must PAUSE (final + awaitingUser), not spin
    // to the next round and not end the flow.
    state.phaseResults[state.pendingAgentId!] = '{"complete": false, "awaiting_user": true}';
    out = orchestrator.resume(state, 'ses_parent_1');
    expect(out.kind).toBe('final');
    expect(out.decision).toBe('awaiting_user');
    expect(out.awaitingUser).toBe(true);
    expect(out.finalOutput).toBe('What brand should we use?');
    expect(state.awaitingUser).toBe(true);
    expect(state.stage).toBe('planify'); // resume at planify (the answer may change the plan)
    expect(state.round).toBe(2);

    // The user answers in the parent pile: [ ..., tool (eval JSON), assistant (question), user (answer) ].
    // The steering detector must capture the answer; the resume must re-emit the planify spawn.
    state.phaseResults = {};
    const pile: UpstreamMessage[] = [
      { role: 'user', content: 'Do the thing', reasoning: '', tool_calls: [] },
      { role: 'assistant', content: '', reasoning: '', tool_calls: [] },
      { role: 'tool', tool_call_id: 'x', tool_name: 'task', content: 'plan', reasoning: '', tool_calls: [] },
      { role: 'tool', tool_call_id: 'y', tool_name: 'task', content: '{"complete": false, "awaiting_user": true}', reasoning: '', tool_calls: [] },
      { role: 'assistant', content: 'What brand should we use?', reasoning: '', tool_calls: [] },
      { role: 'user', content: 'Use the Acme brand', reasoning: '', tool_calls: [] },
    ];
    out = orchestrator.resume(state, 'ses_parent_1', pile);
    expect(out.kind).toBe('tool_call');
    expect(state.awaitingUser).toBe(false);
    expect(state.steering).toContain('Use the Acme brand');
    expect(state.stage).toBe('planify'); // the planify spawn is emitted (result not yet consumed)
    expect(out.toolCall!.id).toBe(`spawn_${state.pendingAgentId}`);
  });

  it('resume(): execute ASK_USER marker stops the loop IMMEDIATELY — no evaluate spawn, marker stripped, user reply resumes at planify', () => {
    const orchestrator = new SubagentOrchestrator(stub(), log);
    const state = makeState();
    state.pendingAgentId = 'agent-p1';
    state.phaseResults['agent-p1'] = JSON.stringify({ description: 'Ask the user the first grilling question' });

    let out = orchestrator.resume(state, 'ses_parent_1'); // planify consumed -> spawn execute
    expect(out.kind).toBe('tool_call');

    // The execute-phase output carries the ASK_USER marker: the question IS the result.
    state.phaseResults[state.pendingAgentId!] = 'ASK_USER: ¿Qué tipo de productos venderá esta tienda?';
    out = orchestrator.resume(state, 'ses_parent_1');
    // IMMEDIATE stop — the proxy did NOT spawn an evaluate for a question it already holds.
    expect(out.kind).toBe('final');
    expect(out.decision).toBe('awaiting_user');
    expect(out.awaitingUser).toBe(true);
    expect(out.finalOutput).toBe('¿Qué tipo de productos venderá esta tienda?'); // marker stripped
    expect(state.awaitingUser).toBe(true);
    expect(state.stage).toBe('planify'); // resume at planify (the answer may change the plan)
    expect(state.round).toBe(2);
    expect(state.pendingAgentId).toBeNull(); // the execute spawn was consumed — no evaluate pending

    // The user answers in the parent pile -> resume at planify (steering captured).
    state.phaseResults = {};
    const pile: UpstreamMessage[] = [
      { role: 'user', content: 'Do the thing', reasoning: '', tool_calls: [] },
      { role: 'assistant', content: '', reasoning: '', tool_calls: [] },
      { role: 'tool', tool_call_id: 'x', tool_name: 'task', content: 'plan', reasoning: '', tool_calls: [] },
      { role: 'tool', tool_call_id: 'y', tool_name: 'task', content: 'ASK_USER: ¿Qué tipo de productos venderá esta tienda?', reasoning: '', tool_calls: [] },
      { role: 'assistant', content: '¿Qué tipo de productos venderá esta tienda?', reasoning: '', tool_calls: [] },
      { role: 'user', content: 'Velas artesanales', reasoning: '', tool_calls: [] },
    ];
    out = orchestrator.resume(state, 'ses_parent_1', pile);
    expect(out.kind).toBe('tool_call');
    expect(state.awaitingUser).toBe(false);
    expect(state.steering).toContain('Velas artesanales');
    expect(state.stage).toBe('planify');
  });

  it('extractAskUser: only a trimmed output STARTING with the marker counts (and the question is returned stripped)', () => {
    expect(extractAskUser('ASK_USER: ¿El carrito necesita descuentos?')).toBe('¿El carrito necesita descuentos?');
    expect(extractAskUser('  ASK_USER:   multi-word question  ')).toBe('multi-word question');
    expect(extractAskUser('ASK_USER:')).toBeNull(); // marker with no question
    expect(extractAskUser('Done. (ASK_USER: was not needed here)')).toBeNull(); // mid-text is NOT a signal
    expect(extractAskUser('')).toBeNull();
  });

  it('resume(): missing phase result does NOT advance the stage, rotates to the next type (fresh agent id) and the result still lands', () => {
    const orchestrator = new SubagentOrchestrator(stub(), log);
    const state = makeState();
    state.pendingAgentId = 'agent-p1';

    // FIRST failure → immediate failover to the next type, FRESH agent id, stage/round untouched.
    const first = orchestrator.resume(state, 'ses_parent_1');
    expect(first.kind).toBe('tool_call');
    expect(first.toolCall!.id).toBe(`spawn_${state.pendingAgentId}`);
    expect(state.pendingAgentId).not.toBe('agent-p1');
    expect(JSON.parse(first.toolCall!.function.arguments).subagent_type).toBe('build');
    expect(state.stage).toBe('planify'); // unchanged
    expect(state.round).toBe(1); // unchanged

    // Once the (re-dispatched) subagent delivers a result, the machine advances from the same position.
    state.phaseResults[state.pendingAgentId!] = JSON.stringify({ description: 'A real step' });
    const third = orchestrator.resume(state, 'ses_parent_1');
    expect(third.kind).toBe('tool_call');
    expect(state.stage).toBe('execute');
    expect(state.task!.description).toBe('A real step');
    expect(state.spawnRetries).toBe(0); // reset by the real result
  });

  it('resume(): EVERY failure rotates to the NEXT type immediately (round-robin over available types)', () => {
    const orchestrator = new SubagentOrchestrator(stub(), log);
    const state = makeState(); // availableTypes = [plan, build, critic], active = plan
    state.pendingAgentId = 'agent-a';
    expect(state.activeTypeId).toBe('plan');

    // Failure #1 → immediate failover to the next type, FRESH agent id.
    const first = orchestrator.resume(state, 'ses_parent_1');
    expect(first.kind).toBe('tool_call');
    expect(state.activeTypeId).toBe('build');
    expect(state.pendingAgentId).not.toBe('agent-a');
    expect(first.toolCall!.id).toBe(`spawn_${state.pendingAgentId}`);
    expect(JSON.parse(first.toolCall!.function.arguments).subagent_type).toBe('build');
    expect(state.spawnRetries).toBe(1);
    expect(state.stage).toBe('planify');

    // Failure #2 → rotates again to the next type (fresh agent id again).
    const idAfterFirst = state.pendingAgentId!;
    const second = orchestrator.resume(state, 'ses_parent_1');
    expect(state.activeTypeId).toBe('critic');
    expect(JSON.parse(second.toolCall!.function.arguments).subagent_type).toBe('critic');
    expect(state.pendingAgentId).not.toBe(idAfterFirst); // fresh id each failure

    // Failure #3 → WRAPS AROUND to the first type.
    const third = orchestrator.resume(state, 'ses_parent_1');
    expect(state.activeTypeId).toBe('plan');
    expect(JSON.parse(third.toolCall!.function.arguments).subagent_type).toBe('plan');

    // Consecutive-failure counter grows and resets only on a real result.
    state.phaseResults[state.pendingAgentId!] = JSON.stringify({ description: 'A real step' });
    orchestrator.resume(state, 'ses_parent_1');
    expect(state.spawnRetries).toBe(0);
    expect(state.activeTypeId).toBe('plan'); // pinned after the successful result
  });

  it('resume(): with a SINGLE available type, failures stay stable (same agent id, no rotation)', () => {
    const orchestrator = new SubagentOrchestrator(stub(), log);
    const state = makeState();
    state.spec = { ...state.spec!, availableTypes: [{ id: 'plan', description: 'Plans work' }] };
    state.activeTypeId = 'plan';
    state.pendingAgentId = 'agent-only';

    const first = orchestrator.resume(state, 'ses_parent_1');
    expect(first.kind).toBe('tool_call');
    expect(first.toolCall!.id).toBe('spawn_agent-only'); // same agent id, idempotent re-emit
    expect(state.activeTypeId).toBe('plan');
    expect(state.pendingAgentId).toBe('agent-only');
    expect(state.stage).toBe('planify');

    // Second failure: still stable.
    const second = orchestrator.resume(state, 'ses_parent_1');
    expect(second.toolCall!.id).toBe('spawn_agent-only');
    expect(state.spawnRetries).toBe(2);
  });

  it('resume(): adopts the phase result from the parent pile when the client executed the spawn itself (strict tool_call_id, plugin-agnostic)', () => {
    const orchestrator = new SubagentOrchestrator(stub(), log);
    const state = makeState();
    state.pendingAgentId = 'agent-p1';

    // The client (with a middle plugin — e.g. opencode-swarm — or a native subagent runner) never
    // routed the subagent through the proxy; the spawn's result comes back as an ordinary
    // `tool` message in the parent's incoming pile, preserving the spawn ToolCall id.
    const pile: UpstreamMessage[] = [
      { role: 'system', content: 'sys', reasoning: '', tool_calls: [] },
      { role: 'user', content: 'Do the thing', reasoning: '', tool_calls: [] },
      {
        role: 'assistant',
        content: '',
        reasoning: '',
        tool_calls: [{ id: 'spawn_agent-p1', type: 'function', function: { name: 'task', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'spawn_agent-p1', tool_name: 'task', content: 'Take a concrete step', reasoning: '', tool_calls: [] },
    ];

    const out = orchestrator.resume(state, 'ses_parent_1', pile);
    expect(out.kind).toBe('tool_call');
    expect(state.stage).toBe('execute'); // consumed, machine advanced
    expect(state.task!.description).toBe('Take a concrete step');
    expect(state.spawnRetries).toBe(0); // a real result arrived — no failover
    expect(state.activeTypeId).toBe('plan'); // type pinned (no rotation)
    expect(state.pendingAgentId).not.toBe('agent-p1'); // consumed
  });

  it('resume(): loose adoption for clients that re-mint tool ids (first tool message after the spawn turn)', () => {
    const orchestrator = new SubagentOrchestrator(stub(), log);
    const state = makeState();
    state.pendingAgentId = 'agent-p2';

    const pile: UpstreamMessage[] = [
      { role: 'user', content: 'Do the thing', reasoning: '', tool_calls: [] },
      {
        role: 'assistant',
        content: '',
        reasoning: '',
        tool_calls: [{ id: 'spawn_agent-p2', type: 'function', function: { name: 'task', arguments: '{}' } }],
      },
      // The client re-minted the tool_call_id — no strict match, but this is the first tool
      // message after the spawn turn.
      { role: 'tool', tool_call_id: 'client-reminted-123', tool_name: 'task', content: 'Loose step', reasoning: '', tool_calls: [] },
    ];

    orchestrator.resume(state, 'ses_parent_1', pile);
    expect(state.stage).toBe('execute');
    expect(state.task!.description).toBe('Loose step');
    expect(state.spawnRetries).toBe(0);

    // STALE results must NOT be adopted: a tool message that belongs to an EARLIER spawn (before
    // the pending one) is ignored, and a missing result still fails over.
    const state2 = makeState();
    state2.pendingAgentId = 'agent-p3';
    const pileStale: UpstreamMessage[] = [
      { role: 'user', content: 'Do the thing', reasoning: '', tool_calls: [] },
      {
        role: 'assistant',
        content: '',
        reasoning: '',
        tool_calls: [{ id: 'spawn_agent-OLD', type: 'function', function: { name: 'task', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'spawn_agent-OLD', tool_name: 'task', content: 'STALE old result', reasoning: '', tool_calls: [] },
      {
        role: 'assistant',
        content: '',
        reasoning: '',
        tool_calls: [{ id: 'spawn_agent-p3', type: 'function', function: { name: 'task', arguments: '{}' } }],
      },
      // …and nothing after the pending spawn: the client never answered it.
    ];

    orchestrator.resume(state2, 'ses_parent_1', pileStale);
    expect(state2.stage).toBe('planify'); // unchanged — failover fired
    expect(state2.pendingAgentId).not.toBe('agent-p3'); // rotated fresh agent id
    expect(state2.activeTypeId).toBe('build'); // rotated type
  });

  it('resume(): after a drift re-mapping (new spec + activeTypeId), spawns use the new type', () => {
    const orchestrator = new SubagentOrchestrator(stub(), log);
    const state = makeState();
    state.pendingAgentId = 'agent-a';
    expect(state.activeTypeId).toBe('plan');

    // Simulates the routes drift handler: the client's type list changed and the mapping was
    // re-run with a new tool schema (fresh type ids).
    const freshTools: ToolDefinition[] = [
      {
        type: 'function',
        function: {
          name: 'task',
          description: 'Launch a new agent.',
          parameters: {
            type: 'object',
            properties: { description: { type: 'string' }, subagent_type: { type: 'string', enum: ['fresh', 'new'] }, prompt: { type: 'string' } },
          },
        },
      },
    ];
    expect(detectTypeDrift(state.spec!, freshTools)).toBe(true);
    state.spec = {
      toolName: 'task',
      argMapping: { title: 'description', type: 'subagent_type', prompt: 'prompt' },
      availableTypes: [{ id: 'fresh', description: '' }, { id: 'new', description: '' }],
      typeId: 'fresh',
    };
    state.activeTypeId = 'fresh';
    state.spawnRetries = 0;

    // The next spawn travels with the new type.
    state.phaseResults['agent-a'] = JSON.stringify({ description: 'A real step' });
    const out = orchestrator.resume(state, 'ses_parent_1');
    expect(out.kind).toBe('tool_call');
    expect(JSON.parse(out.toolCall!.function.arguments).subagent_type).toBe('fresh');
    expect(state.stage).toBe('execute');
  });

  it('resume(): a real phase result resets the failure counter and pins the current type', () => {
    const orchestrator = new SubagentOrchestrator(stub(), log);
    const state = makeState();
    state.pendingAgentId = 'agent-a';
    state.activeTypeId = 'build'; // pretend we already failed over once
    state.spawnRetries = 2; // two consecutive failures before this result arrived

    // The result arrives BEFORE the next resume: no rotation, counter reset, type pinned.
    state.phaseResults['agent-a'] = JSON.stringify({ description: 'A real step' });
    const out = orchestrator.resume(state, 'ses_parent_1');
    expect(out.kind).toBe('tool_call');
    expect(state.activeTypeId).toBe('build'); // pinned — kept for the rest of the session
    expect(state.spawnRetries).toBe(0);
    expect(state.stage).toBe('execute');
  });

  it('resume(): max_rounds exceeded ends with decision max_rounds_exceeded', () => {
    const orchestrator = new SubagentOrchestrator(stub(), log);
    const state = makeState({ max_rounds: 1 });
    state.stage = 'evaluate';
    state.round = 1;
    state.lastOutput = 'Almost there';
    state.pendingAgentId = 'agent-max';
    state.phaseResults['agent-max'] = '{"outcome":"still working"}';
    const out = orchestrator.resume(state, 'ses_parent_1');
    expect(out.kind).toBe('final');
    expect(out.decision).toBe('max_rounds_exceeded');
    expect(out.finalOutput).toBe('Almost there');
  });

  it('runSubagentPhase(): runs one phase, stores the result under agent_id, and returns it', async () => {
    const provider = stub({ evalComplete: true });
    const orchestrator = new SubagentOrchestrator(provider, log);
    const state = makeState();

    // planify phase
    const p1 = await orchestrator.runSubagentPhase({ state, binding: { agentId: 'agent-p', phase: 'planify' }, model: 'm' });
    expect(p1.content).toBe('Take the next step toward the goal.');
    expect(state.phaseResults['agent-p']).toBe('Take the next step toward the goal.');

    // execute phase (default stub output)
    const p2 = await orchestrator.runSubagentPhase({ state, binding: { agentId: 'agent-e', phase: 'execute' }, model: 'm' });
    expect(p2.content).toBe('Task succeeded.');
    expect(state.phaseResults['agent-e']).toBe('Task succeeded.');

    // evaluate phase
    const p3 = await orchestrator.runSubagentPhase({ state, binding: { agentId: 'agent-v', phase: 'evaluate' }, model: 'm' });
    expect(state.phaseResults['agent-v']).toContain('complete');

    expect(state.totalUpstreamCalls).toBe(3);
    expect(provider.calls.length).toBe(3);
  });

  it('resume(): user steering (trailing user turn past the spawn result) is captured and injected into the next planify instruction', async () => {
    const provider = stub();
    const orchestrator = new SubagentOrchestrator(provider, log);
    const state = makeState();
    state.pendingAgentId = 'agent-p1';
    state.phaseResults['agent-p1'] = JSON.stringify({ description: 'Take a step' });

    // The user stopped the client mid-run and typed a new instruction: the client appends it as
    // a trailing user turn AFTER the spawn's tool result.
    const pile: UpstreamMessage[] = [
      { role: 'user', content: 'Do the thing', reasoning: '', tool_calls: [] },
      {
        role: 'assistant',
        content: '',
        reasoning: '',
        tool_calls: [{ id: 'spawn_agent-p1', type: 'function', function: { name: 'task', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'spawn_agent-p1', tool_name: 'task', content: 'plan result', reasoning: '', tool_calls: [] },
      { role: 'user', content: 'Only use vanilla JS, no frameworks', reasoning: '', tool_calls: [] },
    ];
    const out = orchestrator.resume(state, 'ses_parent_1', pile);
    expect(out.kind).toBe('tool_call');
    expect(state.steering).toBe('Only use vanilla JS, no frameworks');
    // The steering turn stays in the refreshed base (every subsequent phase sees it).
    expect(
      state.internalMessages.some((m) => m.role === 'user' && m.content === 'Only use vanilla JS, no frameworks'),
    ).toBe(true);

    // The next planify phase prompt carries the steering directive.
    state.stage = 'planify';
    state.round = 2;
    await orchestrator.runSubagentPhase({ state, binding: { agentId: 'agent-p2', phase: 'planify' }, model: 'm' });
    const last = provider.calls[provider.calls.length - 1].messages;
    const instruction = last[last.length - 1].content as string;
    expect(instruction).toContain('NEW USER DIRECTION');
    expect(instruction).toContain('Only use vanilla JS, no frameworks');
  });

  it('resume(): NO steering on a normal pile, and the original request is never re-read as steering (blocked spawn, no tool results yet)', () => {
    const orchestrator = new SubagentOrchestrator(stub(), log);

    // Normal resume pile (ends AT the spawn's tool result) → no steering.
    const state = makeState();
    state.pendingAgentId = 'agent-n1';
    state.phaseResults['agent-n1'] = JSON.stringify({ description: 'Step' });
    const normalPile: UpstreamMessage[] = [
      { role: 'user', content: 'Do the thing', reasoning: '', tool_calls: [] },
      {
        role: 'assistant',
        content: '',
        reasoning: '',
        tool_calls: [{ id: 'spawn_agent-n1', type: 'function', function: { name: 'task', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'spawn_agent-n1', tool_name: 'task', content: 'r', reasoning: '', tool_calls: [] },
    ];
    orchestrator.resume(state, 'ses_parent_1', normalPile);
    expect(state.steering).toBe('');

    // Blocked re-emission: the pile holds the original request + the (unanswered) spawn
    // dispatch, NO tool results. The original request must NOT be captured as steering.
    const state2 = makeState();
    state2.pendingAgentId = 'agent-n2';
    const blockedPile: UpstreamMessage[] = [
      { role: 'user', content: 'Do the thing', reasoning: '', tool_calls: [] },
      {
        role: 'assistant',
        content: '',
        reasoning: '',
        tool_calls: [{ id: 'spawn_agent-n2', type: 'function', function: { name: 'task', arguments: '{}' } }],
      },
    ];
    orchestrator.resume(state2, 'ses_parent_1', blockedPile);
    expect(state2.steering).toBe('');
  });
});

describe('question tool support (unit)', () => {
  const qNames = ['task', 'question'];

  it('parseQuestionSpec: valid spec (batch)', () => {
    const spec = parseQuestionSpec('{"tool_name":"question","questions_arg":"questions","batch":true}', qNames);
    expect(spec).toEqual({ toolName: 'question', questionsArg: 'questions', batch: true });
  });

  it('parseQuestionSpec: rejects none / unknown tool / missing arg / non-json / array', () => {
    expect(parseQuestionSpec('{"none":true}', qNames)).toBeNull();
    // Names a tool the client does not offer → null.
    expect(parseQuestionSpec('{"tool_name":"ghost","questions_arg":"q","batch":true}', qNames)).toBeNull();
    // No usable questions argument → null.
    expect(parseQuestionSpec('{"tool_name":"question","batch":true}', qNames)).toBeNull();
    // Not JSON / not an object → null.
    expect(parseQuestionSpec('not json', qNames)).toBeNull();
    expect(parseQuestionSpec('[]', qNames)).toBeNull();
  });

  it('buildQuestionToolCall: batch sends all questions, single sends the first only', () => {
    const batchSpec: QuestionToolSpec = { toolName: 'question', questionsArg: 'questions', batch: true };
    const qs = [{ question: 'What color?' }, { question: 'What size?' }];
    const call = buildQuestionToolCall(batchSpec, 'q_abc', qs);
    expect(call.id).toBe('q_abc');
    expect(call.function.name).toBe('question');
    const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
    expect((args.questions as unknown[]).length).toBe(2);

    const singleSpec: QuestionToolSpec = { toolName: 'ask_user', questionsArg: 'prompt', batch: false };
    const call2 = buildQuestionToolCall(singleSpec, 'q_1', qs);
    const args2 = JSON.parse(call2.function.arguments) as Record<string, unknown>;
    expect((args2.prompt as unknown[]).length).toBe(1); // only the first question
  });

  it('parseAskUserQuestions: JSON array / object-wrapped / plain text → null', () => {
    const arr = parseAskUserQuestions('[{"question":"A?","options":[{"label":"x"}]},{"question":"B?","multiple":true}]');
    expect(arr).toHaveLength(2);
    expect(arr![0].question).toBe('A?');
    expect(arr![1].multiple).toBe(true);

    const obj = parseAskUserQuestions('{"questions":[{"question":"C?"}]}');
    expect(obj).toHaveLength(1);
    expect(obj![0].question).toBe('C?');

    expect(parseAskUserQuestions('What brand should we use?')).toBeNull(); // plain text → single mode
    expect(parseAskUserQuestions('[]')).toBeNull();
    expect(parseAskUserQuestions('')).toBeNull();
    expect(parseAskUserQuestions('not json')).toBeNull();
  });

  it('findQuestionAnswer: strict id match, else null', () => {
    const msgs: UpstreamMessage[] = [
      { role: 'user', content: 'go', reasoning: '', tool_calls: [] },
      { role: 'tool', tool_call_id: 'q_1', tool_name: 'question', content: 'The answer', reasoning: '', tool_calls: [] },
    ];
    expect(findQuestionAnswer('q_1', msgs)).toBe('The answer');
    expect(findQuestionAnswer('q_other', msgs)).toBeNull();
    expect(findQuestionAnswer('q_x', null)).toBeNull();
    expect(findQuestionAnswer('q_x', [])).toBeNull();
  });

  it('clientToolNames maps the tool list to names', () => {
    expect(clientToolNames([SPAWN_TOOL, QUESTION_TOOL])).toEqual(['task', 'question']);
  });
});

describe('question tool mapper', () => {
  it('maps the client question tool (batch) when present', async () => {
    const provider = withBothMappings(stub(), VALID_SPEC_JSON, QUESTION_SPEC_JSON);
    const spec = await mapQuestionTool(provider, [SPAWN_TOOL, QUESTION_TOOL], { model: 'm', logger: log });
    expect(spec).toEqual({ toolName: 'question', questionsArg: 'questions', batch: true });
  });

  it('returns null when the client has no question tool', async () => {
    const provider = withBothMappings(stub(), VALID_SPEC_JSON, '{"none":true}');
    const spec = await mapQuestionTool(provider, [SPAWN_TOOL, QUESTION_TOOL], { model: 'm', logger: log });
    expect(spec).toBeNull();
  });

  it('returns null when the mapped tool name is not offered by the client', async () => {
    // tool_name "ghost" is not in the client tools → parseQuestionSpec rejects it.
    const provider = withBothMappings(stub(), VALID_SPEC_JSON, '{"tool_name":"ghost","questions_arg":"questions","batch":true}');
    const spec = await mapQuestionTool(provider, [SPAWN_TOOL, QUESTION_TOOL], { model: 'm', logger: log });
    expect(spec).toBeNull();
  });
});

describe('subagent orchestrator — batch question escalation', () => {
  it('execute ASK_USER(JSON array) -> question ToolCall -> the answer (tool result) resumes planify', async () => {
    const provider = withBothMappings(stub(), VALID_SPEC_JSON, QUESTION_SPEC_JSON);
    const orchestrator = new SubagentOrchestrator(provider, log);
    const state = makeState({ tools: [SPAWN_TOOL, QUESTION_TOOL] });

    const started = await orchestrator.start({
      state,
      sessionId: 'ses_parent_1',
      model: 'm',
      makeSink: () => undefined,
    });
    expect(started).not.toBeNull();
    expect(started!.outcome.kind).toBe('tool_call');
    // The question spec was mapped and is batch-capable.
    expect(state.questionSpec).toEqual({ toolName: 'question', questionsArg: 'questions', batch: true });
    expect(state.totalUpstreamCalls).toBe(3); // spawn-mapping + question-mapping + interpret

    // planify consumed -> spawn execute.
    state.phaseResults[state.pendingAgentId!] = JSON.stringify({ description: 'Pick the brand' });
    let r = orchestrator.resume(state, 'ses_parent_1');
    expect(r.kind).toBe('tool_call');
    expect(r.toolCall!.function.name).toBe('task');
    expect(state.stage).toBe('execute');

    // The execute-phase output is a BATCH of questions for the user (ASK_USER + JSON array).
    const execAgentId = state.pendingAgentId!;
    state.phaseResults[execAgentId] =
      'ASK_USER: ' +
      JSON.stringify([
        { question: 'What brand color?', options: [{ label: 'Red' }, { label: 'Blue' }] },
        { question: 'How many products?', multiple: false },
      ]);
    r = orchestrator.resume(state, 'ses_parent_1');
    // Must be a `question` ToolCall (NOT a spawn), and the loop paused at planify/round+1.
    expect(r.kind).toBe('tool_call');
    expect(r.askingUser).toBe(true);
    expect(r.decision).toBe('tool_calls_pending');
    expect(r.toolCall!.function.name).toBe('question');
    const qargs = JSON.parse(r.toolCall!.function.arguments) as Record<string, unknown>;
    expect((qargs.questions as unknown[]).length).toBe(2);
    expect(state.askingQuestion).toBe(true);
    expect(state.stage).toBe('planify');
    expect(state.round).toBe(2);
    expect(state.pendingQuestionToolCallId).toBe(r.toolCall!.id);

    // The client shows the form; the answer arrives as the question tool call's `tool` result.
    const questionId = r.toolCall!.id;
    const answerPile: UpstreamMessage[] = [
      { role: 'user', content: 'Do the thing', reasoning: '', tool_calls: [] },
      {
        role: 'assistant',
        content: '',
        reasoning: '',
        tool_calls: [{ id: questionId, type: 'function', function: { name: 'question', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: questionId, tool_name: 'question', content: 'Blue. 5 products.', reasoning: '', tool_calls: [] },
    ];
    r = orchestrator.resume(state, 'ses_parent_1', answerPile);
    // Answer consumed -> re-emit the planify spawn (round 2) with the answer as steering.
    expect(r.kind).toBe('tool_call');
    expect(r.toolCall!.function.name).toBe('task');
    expect(state.askingQuestion).toBe(false);
    expect(state.steering).toBe('Blue. 5 products.');
    expect(state.stage).toBe('planify');
    expect(state.round).toBe(2);
  });

  it('re-emits the SAME question (stable id) when the answer has not arrived yet', async () => {
    const provider = withBothMappings(stub(), VALID_SPEC_JSON, QUESTION_SPEC_JSON);
    const orchestrator = new SubagentOrchestrator(provider, log);
    const state = makeState({ tools: [SPAWN_TOOL, QUESTION_TOOL] });
    await orchestrator.start({ state, sessionId: 'ses_parent_1', model: 'm', makeSink: () => undefined });
    state.phaseResults[state.pendingAgentId!] = JSON.stringify({ description: 'Pick' });
    orchestrator.resume(state, 'ses_parent_1'); // -> spawn execute
    const execAgentId = state.pendingAgentId!;
    state.phaseResults[execAgentId] = 'ASK_USER: ' + JSON.stringify([{ question: 'Color?' }]);
    const first = orchestrator.resume(state, 'ses_parent_1'); // -> question ToolCall
    expect(first.kind).toBe('tool_call');
    expect(first.askingUser).toBe(true);
    const id1 = first.toolCall!.id;

    // The client has NOT run the form yet (pile = original request only, no answer).
    const emptyPile: UpstreamMessage[] = [{ role: 'user', content: 'Do the thing', reasoning: '', tool_calls: [] }];
    const second = orchestrator.resume(state, 'ses_parent_1', emptyPile);
    expect(second.kind).toBe('tool_call');
    expect(second.askingUser).toBe(true);
    expect(second.toolCall!.id).toBe(id1); // stable id → idempotent re-emit
    expect(state.askingQuestion).toBe(true);
  });
});
