/**
 * Safe JSON parsing helpers used to tolerate malformed JSON in stored DB
 * columns and other untrusted strings without crashing the surrounding
 * pipeline. Designed for the dashboard read path where one corrupt row
 * should not blow up the whole snapshot.
 *
 * Shape narrowing is the caller's responsibility: `safeJsonParse` does not
 * validate that the parsed value matches T. Use `safeJsonParseArray` /
 * `safeJsonParseRecord` (or pair with a zod schema) when the source data
 * is untrusted in shape, not just in syntax.
 *
 * Warnings are rate-limited per `context` so a broken DB column does not
 * flood logs during a single dashboard load.
 */

const WARNING_INTERVAL_MS = 60_000;
const lastWarnedAt = new Map<string, number>();

function warnRateLimited(context: string | undefined, error: unknown): void {
  if (!context) {
    return;
  }
  const now = Date.now();
  const last = lastWarnedAt.get(context) ?? 0;
  if (now - last < WARNING_INTERVAL_MS) {
    return;
  }
  lastWarnedAt.set(context, now);
  const message = error instanceof Error ? error.message : String(error);
  console.warn("safeJson.parseError", { context, error: message });
}

export function safeJsonParse<T>(
  value: string | null | undefined,
  fallback: T,
  context?: string
): T {
  if (value === null || value === undefined) {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    if (error instanceof SyntaxError) {
      warnRateLimited(context, error);
      return fallback;
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
  const parsed = safeJsonParse<unknown>(value, [], context);
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
  const parsed = safeJsonParse<unknown>(value, {}, context);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return {};
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
  try {
    const parsed = JSON.parse(line) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
