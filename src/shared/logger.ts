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
/**
 * Ring buffer backing `record()` and `readLogBuffer()`. Stored as a fixed-
 * size circular buffer (write index wraps) so eviction is O(1) instead of
 * the O(n) shift the original implementation paid on every log call once
 * full. (audit-2026-05-17 L2)
 */
const buffer: (LogEntry | undefined)[] = new Array<LogEntry | undefined>(LOG_BUFFER_SIZE);
let writeIndex = 0;
let entriesWritten = 0;

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
  buffer[writeIndex] = entry;
  writeIndex = (writeIndex + 1) % LOG_BUFFER_SIZE;
  entriesWritten++;
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
  // Before the buffer fills, `writeIndex` IS the count of valid entries and
  // they're contiguous from index 0. After it fills, `writeIndex` is the
  // oldest slot — reconstruct oldest-first by slicing [writeIndex..end] then
  // [0..writeIndex].
  if (entriesWritten <= LOG_BUFFER_SIZE) {
    return buffer.slice(0, entriesWritten) as LogEntry[];
  }
  return [...buffer.slice(writeIndex), ...buffer.slice(0, writeIndex)] as LogEntry[];
}

/** Test-only: clear the buffer between fixtures. */
export function resetLogBufferForTesting(): void {
  for (let i = 0; i < LOG_BUFFER_SIZE; i++) buffer[i] = undefined;
  writeIndex = 0;
  entriesWritten = 0;
}
