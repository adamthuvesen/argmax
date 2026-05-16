/**
 * Centralized structured logger for main + renderer.
 *
 * API: `logger.debug/info/warn/error(scope, message, fields?)`.
 *
 * - `scope`: short identifier of the subsystem (`"providers.session"`,
 *   `"renderer.error-boundary"`).
 * - `message`: human-readable string.
 * - `fields`: optional JSON-serializable record. Use this for any structured
 *   metadata you want to query later (`{ sessionId, ms }` — NOT `${error}`
 *   stringified into the message).
 *
 * In-memory ring buffer (`LOG_BUFFER_SIZE` lines) is per-process. Main
 * process callers can `readBuffer()` to surface entries through diagnostics
 * IPC. The renderer maintains its own buffer; the diagnostics panel reads
 * the main-side buffer through system:diagnostics.
 *
 * Console mirroring is gated on `process.env.DEBUG === "1"` so prod runs
 * stay quiet. `level === "error"` always mirrors regardless of DEBUG so
 * a fatal stays visible without an extra env var.
 */

import type { LogEntry, LogLevel } from "./types.js";
export type { LogEntry, LogLevel };

const LOG_BUFFER_SIZE = 1000;
const buffer: LogEntry[] = [];

function isDebugEnabled(): boolean {
  // Read each call so tests that toggle `process.env.DEBUG` between calls
  // see the new value. The cost is negligible.
  return (
    typeof process !== "undefined" &&
    typeof process.env !== "undefined" &&
    process.env.DEBUG === "1"
  );
}

function consoleFor(level: LogLevel): (...args: unknown[]) => void {
  switch (level) {
    case "debug":
      return console.debug.bind(console);
    case "info":
      return console.info.bind(console);
    case "warn":
      return console.warn.bind(console);
    case "error":
      return console.error.bind(console);
  }
}

function record(level: LogLevel, scope: string, message: string, fields?: Record<string, unknown>): void {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    scope,
    message,
    fields: fields ?? {}
  };
  buffer.push(entry);
  if (buffer.length > LOG_BUFFER_SIZE) {
    buffer.shift();
  }
  // Error always mirrors so it's noticeable without DEBUG=1. Other levels
  // need the explicit opt-in.
  if (level === "error" || isDebugEnabled()) {
    const out = consoleFor(level);
    if (Object.keys(entry.fields).length > 0) {
      out(`[${scope}] ${message}`, entry.fields);
    } else {
      out(`[${scope}] ${message}`);
    }
  }
}

export const logger = {
  debug(scope: string, message: string, fields?: Record<string, unknown>): void {
    record("debug", scope, message, fields);
  },
  info(scope: string, message: string, fields?: Record<string, unknown>): void {
    record("info", scope, message, fields);
  },
  warn(scope: string, message: string, fields?: Record<string, unknown>): void {
    record("warn", scope, message, fields);
  },
  error(scope: string, message: string, fields?: Record<string, unknown>): void {
    record("error", scope, message, fields);
  },
  /**
   * Log a measured duration. `ms` is rounded to 1 decimal (sub-ms values
   * collapse to 0). Lands as an info-level entry under the given scope with
   * `{ ms, ...fields }` so the Diagnostics → Logs filter can pick them out
   * by scope. Use anywhere a `performance.now()` diff would otherwise be
   * console-logged ad-hoc.
   */
  timing(scope: string, label: string, ms: number, fields?: Record<string, unknown>): void {
    const rounded = Number.isFinite(ms) ? Math.round(ms * 10) / 10 : 0;
    record("info", scope, label, { ms: rounded, ...(fields ?? {}) });
  }
};

/** Returns the current ring-buffer contents oldest-first. */
export function readLogBuffer(): LogEntry[] {
  return buffer.slice();
}

/** Test-only: clear the buffer between fixtures. */
export function resetLogBufferForTesting(): void {
  buffer.length = 0;
}
