/**
 * Normalize an unknown thrown value to a string suitable for logs, dialog
 * boxes, and persisted error rows. Tauri command errors arrive as serialized
 * objects, so prefer their `message` field before falling back to String().
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
}
