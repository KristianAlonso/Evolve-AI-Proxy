import { describe, it, expect, vi } from 'vitest';
import { SseWriter, SSE_EVENTS } from '../presentation/sse-writer.js';

// Minimal FastifyReply stand-in that captures what the writer streams. We don't start a server:
// we just assert the emitted SSE framing is well-formed (SC-009/010) and surfaces disconnects (SC-023).
function fakeReply() {
  const sent: string[] = [];
  const reply: any = {
    type(_v?: string) { return reply; },
    header(_k?: string, _v?: string) { return reply; },
    raw: { on: (_e: string, _cb: () => void) => {}, write: (s: string) => { sent.push(s); } },
    send: (s: string) => { sent.push(s); },
    get __sent() { return sent; },
  };
  return reply;
}

describe('SseWriter (SC-009/010)', () => {
  it('wraps emitted events in a valid SSE frame with event/id/data lines', () => {
    const reply = fakeReply();
    const w = new SseWriter(reply);
    w.writeEvent(SSE_EVENTS.phaseUpdate, { phase: 'interpreting' });

    const frames = reply.__sent.join('');
    expect(frames).toContain('event: phase_update');
    expect(frames).toContain('id: ');
    expect(frames).toContain('data: {"phase":"interpreting"}');
  });

  it('writes a ready line and reasoning markers on construction/emit', () => {
    const reply = fakeReply();
    const w = new SseWriter(reply);
    w.emitReasoning(1, 'thinking...');
    const frames = reply.__sent.join('');
    expect(frames).toContain('__REASONING_START__');
    expect(frames).toContain('thinking...');
    expect(frames).toContain('__REASONING_END__');
  });

  it('reports isDisconnected true after the socket closes (SC-023)', () => {
    let onClose: (() => void) | null = null;
    const reply = {
      type: () => reply,
      header: () => reply,
      raw: { on: (ev: string, cb: () => void) => { if (ev === 'close') onClose = cb; }, write: (_s: string) => {} },
      send: vi.fn(),
    } as unknown as import('fastify').FastifyReply;
    const w = new SseWriter(reply);
    expect(w.isDisconnected).toBe(false);
    onClose!();
    expect(w.isDisconnected).toBe(true);
  });

  it('writes nothing once disconnected', () => {
    let onClose: (() => void) | null = null;
    const sent: string[] = [];
    const reply = {
      type: () => reply,
      header: () => reply,
      raw: { on: (ev: string, cb: () => void) => { if (ev === 'close') onClose = cb; }, write: (_s: string) => {} },
      send: vi.fn((s: string) => { sent.push(s); }),
    } as unknown as import('fastify').FastifyReply;
    const w = new SseWriter(reply);
    onClose!();
    expect(() => w.writeEvent(SSE_EVENTS.phaseUpdate, { phase: 'planning' })).toThrow();
  });
});
