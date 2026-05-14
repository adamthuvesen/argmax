/**
 * Normalize an unknown thrown value to a string suitable for logs, dialog
 * boxes, and persisted error rows. Plain `Error` instances yield `.message`;
 * everything else is `String(value)` so we never trip over `[object Object]`.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
