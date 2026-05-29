/**
 * Safe JSON parsing helpers used to tolerate malformed JSON in stored DB
 * columns and other untrusted strings without crashing the surrounding
 * pipeline. Designed for the dashboard read path where one corrupt row
 * should not blow up the whole snapshot.
 *
 * Shape narrowing is the caller's responsibility: `safeJsonParse` does not
 * validate that the parsed value matches T. Use `safeJsonParseArray` /
 * `safeJsonParseRecord`  when the source data
 * is untrusted in shape, not just in syntax.
 *
 * Warnings are rate-limited per `context` so a broken DB column does not
 * flood logs during a single dashboard load.
 */

import { BoundedMap } from "./boundedSet.js";
import { logger } from "./logger.js";
import { errorMessage } from "./error.js";
import { isPlainObject } from "./typeGuards.js";

const WARNING_INTERVAL_MS = 60_000;
// Bounded so long-running mains with many distinct contexts (dynamic ids in
// log breadcrumbs) don't leak this dedup ledger. 200 distinct contexts is
// generous for the static set we use today.
const lastWarnedAt = new BoundedMap<string, number>(200);

export function resetSafeJsonWarningsForTesting(): void {
  lastWarnedAt.clear();
}

function warnRateLimited(context: string | undefined, error: unknown): void {
  // Context-less callers used to be silently dropped, which meant a corrupt
  // row hit via `safeJsonParse(value)` (no context arg) gave zero
  // observability. Treat undefined as a single shared "unknown" bucket so
  // the warning still fires (rate-limited like any other context).
  // (audit-2026-05-17 L3)
  const key = context ?? "<unknown>";
  const now = Date.now();
  const last = lastWarnedAt.get(key) ?? 0;
  if (now - last < WARNING_INTERVAL_MS) {
    return;
  }
  lastWarnedAt.set(key, now);
  logger.warn("safeJson", "parse error", { context: key, error: errorMessage(error) });
}

/**
 * Returns the parsed JSON as `unknown` (never `T`). The previous `<T>`
 * generic was an unsafe cast that lied about runtime shape — every caller
 * already used `safeJsonParseArray` / `safeJsonParseRecord` (which narrow
 * properly) or `safeJsonParse<unknown>`. Drop the trap and force callers
 * through a narrowing helper.
 */
export function safeJsonParse(
  value: string | null | undefined,
  context?: string
): unknown {
  if (value === null || value === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      warnRateLimited(context, error);
      return undefined;
    }
    throw error;
  }
}

/**
 * Parses a JSON string that should be an array of `T`. Filters out elements
 * that fail the predicate. Returns `[]` on parse failure or non-array shape.
 */
export function safeJsonParseArray<T>(
  value: string | null | undefined,
  predicate: (item: unknown) => item is T,
  context?: string
): T[] {
  const parsed = safeJsonParse(value, context);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter(predicate);
}

/**
 * Parses a JSON string that should be a plain object. Returns `{}` on parse
 * failure, null, array, or any non-object shape.
 */
export function safeJsonParseRecord(
  value: string | null | undefined,
  context?: string
): Record<string, unknown> {
  const parsed = safeJsonParse(value, context);
  return isPlainObject(parsed) ? parsed : {};
}

/**
 * Tries to parse a single line as a JSON object without warning on failure.
 * Returns null when the line isn't `{`-prefixed, fails to parse, or parses
 * to a non-object value. Used by streaming parsers that mix JSON and plain
 * text lines and don't want warnings on every non-JSON line.
 */
export function tryParseJsonObject(line: string): Record<string, unknown> | null {
  if (!line.startsWith("{")) {
    return null;
  }
  return safeJsonParseObject(line);
}

/**
 * Parse a JSON document as a plain object (not an array, not a primitive).
 * Returns null on parse failure or wrong shape. Unlike `tryParseJsonObject`,
 * this does not require a `{` prefix — use it for whole `gh`/`codex` stdout
 * blobs that may have leading whitespace.
 */
export function safeJsonParseObject<T = Record<string, unknown>>(text: string): T | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return isPlainObject(parsed) ? (parsed as T) : null;
  } catch {
    return null;
  }
}
