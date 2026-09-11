// File-backed structured logger with automatic per-file rotation (~10 MB/file).
// SC-025: timestamps, session ids, severity levels; auto-rotate at 10 MB.

import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import env from './config.js';

type Level = 'debug' | 'info' | 'warn' | 'error';

interface Line {
  ts: string;
  level: Level;
  sid?: string;
  msg: string;
}

const MAX_BYTES_PER_FILE = 10 * 1024 * 1024; // rotate after this many bytes/file
let currentSeq = seqFromNow();
let flushed = false;
const buffer: Line[] = [];

function seqFromNow(): number {
  const d = new Date();
  return Number(d.toISOString().slice(0, 10).replace(/-/g, '')); // YYYYMMDD
}

function flush(force = false): void {
  if (buffer.length === 0 && !force) return;
  try {
    mkdirSync(env.LOG_DIR, { recursive: true });
    const fname = `${env.LOG_DIR}/evolve-proxy-${currentSeq}.log`;
    writeFileSync(fname, buffer.map(formatLine).join('\n') + '\n');
    flushed = true;
    buffer.length = 0;
  } catch {
    /* logging must never crash a request */
  }
}

function rotateIfNeeded(): void {
  if (!flushed) return;
  try {
    const size = statSync(`${env.LOG_DIR}/evolve-proxy-${currentSeq}.log`).size;
    if (size > MAX_BYTES_PER_FILE) {
      currentSeq += 1;
      flushed = false;
    }
  } catch {
    /* ignore */
  }
}

function formatLine(l: Line): string {
  const time = new Date().toISOString();
  return `${time} [${l.level.toUpperCase()}] ${l.sid ?? '-'} ${l.msg}`;
}

/** Build a logger bound to one session id (SC-025 per-request audit trail). */
export function createLogger(sessionId: string) {
  return {
    debug(msg: string): void { log('debug', sessionId, msg); },
    info(msg: string): void { log('info', sessionId, msg); },
    warn(msg: string): void { log('warn', sessionId, msg); },
    error(msg: string): void { log('error', sessionId, msg); },
  };
}

function log(level: Level, sid: string | undefined, msg: string): void {
  buffer.push({ ts: new Date().toISOString(), level, sid, msg });
  if (buffer.length >= 1024) flush(true);
  rotateIfNeeded();
}
