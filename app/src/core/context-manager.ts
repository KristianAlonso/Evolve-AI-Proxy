// Context-window management (FR-014 / SC-021, SC-022).
// Tracks accumulated token usage across iterations. When the projected context crosses 75%
// of the configured window, it condenses prior steps into a single summary that preserves:
// the original objective, tasks successfully completed, and key results per iteration.

export interface ContextStep {
  iteration: number;
  objective?: string;
  task_id?: string;
  output: string;   // what was produced this step
  successful: boolean;
}

const CONDENSE_THRESHOLD = 0.75; // SC-021

export class ContextManager {
  private steps: ContextStep[] = [];
  /** Live token accounting (SC-022). */
  promptTokens = 0;
  completionTokens = 0;

  constructor(private windowSize: number) {}

  setWindowSize(size: number): void { this.windowSize = size; }

  record(step: ContextStep): void { this.steps.push(step); }

  clear(): void { this.steps = []; }

  /** Projected total context in tokens (best-effort estimate). */
  get projectedTokens(): number {
    const historySum = this.steps.reduce((acc, s) => acc + Math.max(4, s.output.split(' ').length * 1.3), 0);
    return this.promptTokens + this.completionTokens + historySum;
  }

  /** Whether condensation is required to stay within the window (SC-021). */
  shouldCondense(): boolean {
    if (this.windowSize <= 0) return false;
    return this.projectedTokens / this.windowSize > CONDENSE_THRESHOLD;
  }

  /** Condensed context string to inject in later rounds. SC-021 preserves objective + completed tasks + key results. */
  condense(): { summary: string; remainingSteps: ContextStep[] } {
    const objectives = this.steps.map((s) => s.objective).filter(Boolean);
    const completedTasks = this.steps.filter((s) => s.successful).map((s) => `task ${s.task_id ?? s.iteration}`);
    const keyResults = this.steps.map((s, i) => {
      const out = s.output.trim().slice(0, 200);
      return `- iter ${i + 1}${s.successful ? ' ✓' : ' ✗'}: ${out || '(empty)'}`;
    });

    const summary = [
      `Original objective(s):`,
      ...objectives.map((o) => `  - ${o}`).slice(0, 20),
      '',
      `Tasks completed successfully:`,
      ...completedTasks.slice(0, 30),
      '',
      `Per-step results (condensed):`,
      ...keyResults,
    ].join('\n');

    // Keep only the most recent few steps so the loop keeps flowing. SC-021.
    return { summary, remainingSteps: this.steps.slice(-3) };
  }

  get length(): number { return this.steps.length; }
}
