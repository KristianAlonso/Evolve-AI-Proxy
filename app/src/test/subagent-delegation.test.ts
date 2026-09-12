// FASE 6 — subagent phase delegation: unit tests for the spawn contract, the tool mapper and the
// orchestrator state machine. No network — every provider is a local stub.

import { describe, expect, it } from 'vitest';
import { createLogger, type TraceLogger } from '../logger.js';
import type { ProviderCallOptions } from '../provider/types.js';
import type { NormalizedResult } from '../types.js';
import type { ToolCall, ToolDefinition, UpstreamMessage } from '../types.js';
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
} from '../core/subagent-spawn.js';
import { mapSubagentTool } from '../core/subagent-mapper.js';
import { SubagentOrchestrator, type OrchestratorOutcome } from '../core/orchestrator.js';
import { newLoopState, type LoopStateData } from '../core/loop-state.js';
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
    expect(env.phase).toBe('planify');
    expect(env.parent_session_id).toBe('ses_parent_1');
    expect(state.pendingAgentId).toBe(env.agent_id);
    expect(state.stage).toBe('planify');
    expect(state.spec).not.toBeNull();
    expect(state.activeTypeId).toBe('plan'); // pinned from spec.typeId at start
    expect(sinkCreated).toBe(true);
    expect(state.totalUpstreamCalls).toBe(2); // mapping + interpret
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

    // execute consumed -> evaluate with the accumulated step
    const execAgentId = state.pendingAgentId!;
    state.phaseResults[execAgentId] = 'Output A';
    const out2 = orchestrator.resume(state, 'ses_parent_1');
    expect(out2.kind).toBe('tool_call');
    expect(state.stage).toBe('evaluate');
    expect(state.lastOutput).toBe('Output A');
    expect(state.accumulatedSteps.length).toBe(1);
    expect(state.accumulatedSteps[0].output).toBe('Output A');

    // evaluate "continue" with round < max_rounds -> next round planify
    const evalAgentId = state.pendingAgentId!;
    state.phaseResults[evalAgentId] = '{"outcome":"still working"}';
    const out3 = orchestrator.resume(state, 'ses_parent_1');
    expect(out3.kind).toBe('tool_call');
    expect(state.stage).toBe('planify');
    expect(state.round).toBe(2);

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
});
