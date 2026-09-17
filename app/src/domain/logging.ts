// Traced-logger CONTRACT for the domain and application layers.
//
// The concrete implementation lives in the infrastructure layer
// (`infrastructure/logger.ts` — file-backed, per-line rotation, console mirror). The domain
// only ever sees this interface, so it never touches file I/O or the logger's env config:
// a domain object created without an injected logger gets a no-op one instead of importing
// the infrastructure logger itself.

/** A logger bound to one session and (optionally) one request trace id. */
export interface TraceLogger {
  debug(msg: string, consoleLine?: string): void;
  info(msg: string, consoleLine?: string): void;
  warn(msg: string, consoleLine?: string): void;
  error(msg: string, consoleLine?: string): void;
  /** Return a copy of this logger bound to the given trace id. */
  traced(traceId: string): TraceLogger;
  /**
   * INFO request-result line: the LOG FILE receives the plain `fileMsg`; the CONSOLE mirror
   * receives `consoleLine`, which may carry ANSI colors (e.g. a colorized HTTP status).
   */
  requestResult(fileMsg: string, consoleLine: string): void;
}

/** A logger that drops every line — fallback for domain objects created without one (tests). */
export function createNoopLogger(): TraceLogger {
  const noop = (): void => {
    /* deliberately silent */
  };
  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    traced: () => createNoopLogger(),
    requestResult: noop,
  };
}
