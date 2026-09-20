import { errorMessage } from "../../shared/error.js";

export interface ToastMessage {
  kind: "info" | "error";
  message: string;
  /** What the backend said, shown under the message in a quieter line. */
  detail?: string;
}

/**
 * Run an async IPC call, surfacing any rejection as an error toast. Returns
 * `true` on success and `false` on failure so the caller can short-circuit
 * follow-up state mutations (refresh, selection updates) when the underlying
 * action did not complete.
 *
 * The headline is always the caller's wording, because only the caller knows
 * which action failed — a backend string like "no such column: pinned" names
 * the cause but not the act. The backend string rides along as `detail`
 * rather than being hidden: when it is the useful half, it is right there.
 */
export async function withToast(
  fn: () => Promise<unknown>,
  setToast: (toast: ToastMessage) => void,
  fallback: string
): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (error) {
    const detail = error == null ? "" : errorMessage(error);
    setToast({
      kind: "error",
      message: fallback,
      ...(detail && detail !== fallback ? { detail } : {})
    });
    return false;
  }
}
