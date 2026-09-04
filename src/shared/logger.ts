/**
 * Centralized structured logger for renderer-side diagnostics.
 *
 * API: `logger.info/warn/error(scope, message, fields?)`.
 *
 * - `scope`: short identifier of the subsystem (`"providers.session"`,
 *   `"renderer.error-boundary"`).
 * - `message`: human-readable string.
 * - `fields`: optional JSON-serializable record. Use this for any structured
 *   metadata you want to query later (`{ sessionId, ms }` — NOT `${error}`
 *   stringified into the message).
 *
 * Console mirroring is gated on `process.env.DEBUG === "1"` so prod runs
 * stay quiet. `level === "error"` always mirrors regardless of DEBUG so
 * a fatal stays visible without an extra env var.
 */

type LogLevel = "info" | "warn" | "error";

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
    case "info":
      return console.info.bind(console);
    case "warn":
      return console.warn.bind(console);
    case "error":
      return console.error.bind(console);
  }
}

function record(level: LogLevel, scope: string, message: string, fields?: Record<string, unknown>): void {
  // Error always mirrors so it's noticeable without DEBUG=1. Other levels
  // need the explicit opt-in.
  if (level === "error" || isDebugEnabled()) {
    const out = consoleFor(level);
    if (fields && Object.keys(fields).length > 0) {
      out(`[${scope}] ${message}`, fields);
    } else {
      out(`[${scope}] ${message}`);
    }
  }
}

export const logger = {
  info(scope: string, message: string, fields?: Record<string, unknown>): void {
    record("info", scope, message, fields);
  },
  warn(scope: string, message: string, fields?: Record<string, unknown>): void {
    record("warn", scope, message, fields);
  },
  error(scope: string, message: string, fields?: Record<string, unknown>): void {
    record("error", scope, message, fields);
  },
};
