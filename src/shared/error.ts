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

/** The `sub_code` a Tauri command error carries, when it has one. */
export function errorSubCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "sub_code" in error) {
    const subCode = (error as { sub_code?: unknown }).sub_code;
    if (typeof subCode === "string") return subCode;
  }
  return undefined;
}
