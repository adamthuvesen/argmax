/**
 * Type guards shared between main and renderer. Keep these small, pure, and
 * dependency-free — `pathlib`-style primitives that callers compose.
 */

/**
 * Narrow `unknown` to a plain JSON-shaped object (not null, not an array).
 * Use at boundaries where JSON or IPC payloads cross into typed code.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns the value if it's a non-empty string, otherwise null. */
export function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Returns the value if it's a plain object, otherwise null. */
export function objectValue(value: unknown): Record<string, unknown> | null {
  return isPlainObject(value) ? value : null;
}

/** Returns the value if it's an array, otherwise null. */
export function arrayValue(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}
