import { errorMessage } from "../../shared/error.js";

export interface ToastMessage {
  kind: "info" | "error";
  message: string;
}

/**
 * Run an async IPC call, surfacing any rejection as an error toast. Returns
 * `true` on success and `false` on failure so the caller can short-circuit
 * follow-up state mutations (refresh, selection updates) when the underlying
 * action did not complete.
 *
 * Consolidates the `try/catch + setToast` pattern that previously repeated at
 * every IPC call site in `App.tsx` — keeps the toast wording in one place per
 * action and trims a ~6-line block down to a single helper invocation.
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
    setToast({ kind: "error", message: errorMessage(error) || fallback });
    return false;
  }
}
