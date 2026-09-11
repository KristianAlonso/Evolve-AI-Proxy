// Shared type surface for the evolve proxy agent loop.
// Kept framework-agnostic so provider, sse and core modules stay decoupled.

/** Role of an upstream OpenAI-style chat message. */
export type UpstreamRole = 'system' | 'user' | 'assistant' | 'tool';

/** A tool call emitted natively by a model (rare for these models, but handled). */
export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** Raw upstream chat message as delivered by the provider layer. */
export interface UpstreamMessage {
  role: UpstreamRole;
  content: string | null;
  reasoning?: string;        // extracted reasoning/thinking, '' when none
  tool_calls?: ToolCall[];   // native tool calls, [] when none
}

/** Token accounting reported by upstream. */
export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** A single normalized turn produced by a provider call. */
export interface NormalizedResult {
  content: string | null;    // assistant text (excluding thinking)
  reasoning: string;         // extracted reasoning/thinking, '' when none
  tool_calls: ToolCall[];    // native tool calls the model requested
  usage?: TokenUsage;
  refused: boolean;          // true when upstream returned a refusal/rejection
  finish_reason: string | null;
  raw: Record<string, unknown>; // debug / logging convenience
}

/** System-level parameters accepted by the proxy in addition to the OpenAI body. */
export interface ProxyRequest {
  model?: string;
  messages: UpstreamMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number | null;

  // Evolve-specific controls (SC-012 / SC-013 / SC-017 / SC-022).
  doom_loop_threshold?: number;   // default 4
  max_retries?: number;           // default 3
  max_rounds?: number;            // default 10
  context_window_size?: number | null;
}

/** Self-contained executable instruction generated for one step of the loop (SC-005). */
export interface AgentTask {
  id: string;
  description: string;          // instruction an isolated model run can execute unambiguously
  context_needed: string[];     // resources/context to gather before executing
  reasoning?: string;           // why this task was produced (for client tracing)
}

export type TaskStatus = 'pending' | 'executing' | 'completed' | 'failed';

/** Outcome of running an AgentTask (retained even across retries, SC-014). */
export interface TaskResult {
  id: string;
  status: TaskStatus;
  output: string;               // model text produced for the task
  reasoning: string;            // concatenated per-attempt reasoning traces shown to client
  attempts: number;             // how many upstream calls were made
  error?: string;               // non-null on final failure after retries exhausted
}

/** A step of internal reasoning/context surfaced to the client through SSE. */
export interface ReasoningTrace {
  iteration: number;
  phase:
    | 'interpret'
    | 'planify'
    | 'execute'
    | 'evaluate'
    | 'cleanup'
    | 'retry'
    | 'doom_loop';
  content: string;              // text visible to the client (reasoning or reasoning markers)
  tool_calls?: ToolCall[];
}

export type LoopDecision =
  | 'complete'
  | 'continue'
  | 'error'
  | 'max_rounds_exceeded'
  | 'refusal_exhausted';

/** Options passed from the orchestrator down into a provider call. */
export interface CallOptions {
  stream: boolean;
  max_tokens?: number | null;
  temperature?: number;
  context_window_size: number;
}
