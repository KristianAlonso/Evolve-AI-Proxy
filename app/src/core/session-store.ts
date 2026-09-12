// In-memory store of in-flight bidirectional tool-delegation sessions (FASE 2).
//
// When the loop pauses because the upstream model requested client-side tool calls
// (decision 'tool_calls_pending'), the proxy records the pending state under the
// session id carried in the `x-session-id` header. When the client resumes the
// conversation (assistant tool_calls + tool results re-sent, same session) the loop
// runs again and, once it reaches a terminal decision, the session is deleted.
//
// The store is intentionally thin: the full conversation travels in every incoming
// request's `messages` array (OpenAI semantics), so only the small pending-tool-call
// state lives here. TTL-pruned so a client that never comes back cannot leak memory.

import type { ToolCall, ToolChoice, ToolDefinition } from '../types.js';
import type { LoopStateData } from './loop-state.js';

/** One in-flight tool-delegation session. */
export interface ToolDelegateSession {
  sessionId: string;
  /** The concrete upstream model bound to the session. */
  model: string;
  /** Tools the client originally sent — replayed on the resume call so the model keeps its toolbox. */
  tools?: ToolDefinition[];
  tool_choice?: ToolChoice;
  /** The tool calls the client still owes results for. */
  pendingToolCalls: ToolCall[];
  /** FASE 6: resumable orchestrator state for subagent phase delegation (orchestrator mode only). */
  loopState?: LoopStateData;
  /**
   * FASE 6: subagent x-session-id -> binding into the parent loop, so a subagent's follow-up
   * (continuation) requests route correctly even after the spawn prompt is no longer the last
   * message in its conversation.
   */
  subagentBindings?: Record<string, { parentSessionId: string; agentId: string; phase: string }>;
  createdAt: number;
  updatedAt: number;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes without a resume → the session evaporates

export class SessionStore {
  private readonly sessions = new Map<string, ToolDelegateSession>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /** Record (or refresh) a pending tool-delegation session. */
  save(session: ToolDelegateSession): void {
    session.updatedAt = Date.now();
    if (session.createdAt === undefined) session.createdAt = session.updatedAt;
    this.sessions.set(session.sessionId, session);
    this.prune();
  }

  /** Fetch a live session, evicting it when it has expired. */
  get(sessionId: string): ToolDelegateSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    if (Date.now() - session.updatedAt > this.ttlMs) {
      this.sessions.delete(sessionId);
      return undefined;
    }
    return session;
  }

  /** Drop a session (terminal decision reached, or explicit invalidation). */
  delete(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** Number of live sessions (tests / observability). */
  get size(): number {
    this.prune();
    return this.sessions.size;
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.updatedAt > this.ttlMs) this.sessions.delete(id);
    }
  }
}
