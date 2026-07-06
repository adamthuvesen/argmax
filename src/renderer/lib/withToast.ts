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
 * Keeps toast wording in one place per action and lets call sites stay focused
 * on the state change after a successful IPC call.
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
    // Use the fallback only when there's no usable Error.message. Distinguish
    // the missing-error case from a legitimate empty message by checking the
    // error itself, not the stringified result — `new Error("")` is still an
    // Error and its emptiness is informational (backend validation sometimes emits one).
    const fromError = error instanceof Error ? error.message : "";
    setToast({
      kind: "error",
      message: fromError || (error == null ? fallback : errorMessage(error)) || fallback
    });
    return false;
  }
}
