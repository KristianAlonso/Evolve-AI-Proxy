// Task generation phase (FR-003 / SC-005).
// Turns the structured interpretation into concrete, self-contained executable tasks.

import type { ChatProvider } from './provider/types.js';
import type { AgentTask } from './types.js';
import type { Interpretation } from './interpreter.js';

let taskSeq = 0;

export function genId(): string {
  return `task-${Date.now().toString(36)}-${++taskSeq}`;
}

/** Produce one executable task for each sub-goal, or a single umbrella task. */
export async function generateTasks(
  provider: ChatProvider,
  originalInstruction: string,
  interp: Interpretation,
): Promise<AgentTask[]> {
  if (!interp.mainObjective) {
    return [mkTask('Address the original request with whatever content was provided.', interp)];
  }

  const targets = interp.subObjectives.length ? interp.subObjectives : [interp.mainObjective];
  return targets.map((sub) => mkTask(sub, interp));
}

function mkTask(describe: string, ctx: Interpretation): AgentTask {
  const description = [
    'Original instruction:',
    ` ${ctx.mainObjective}`,
    '',
    'Sub-goal for this task:',
    ` ${describe}`,
    '',
    'Context / resources to gather before executing (if any):',
    ctx.resourcesNeeded.length ? `${ctx.resourcesNeeded.map((r) => `  - ${r}`).join('\n')}` : '  (none specified by interpreter)',
  ].join('\n');

  return { id: genId(), description, context_needed: [...ctx.resourcesNeeded] };
}
