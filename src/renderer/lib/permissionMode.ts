/**
 * User preference for provider permission gating.
 *
 * - `auto-approve`: provider launches with the broad bypass flags
 *   (`bypassPermissions` / `--dangerously-bypass-approvals-and-sandbox` /
 *   `--force --trust`). This is the historical default for Argmax — a trusted
 *   single-user desktop app — but it removes the per-command confirmation
 *   gate that providers ship with.
 * - `ask-each-time`: drop the bypass flags. Each tool invocation goes through
 *   the provider's native approval gate, which Argmax surfaces as in-app
 *   Approve / Reject buttons (P8.02).
 *
 * Persisted to localStorage. Reads tolerate missing/corrupt values by
 * returning the safe default.
 */
export type PermissionMode = "auto-approve" | "ask-each-time";

export const PERMISSION_MODE_KEY = "argmax.permissionMode";
export const DEFAULT_PERMISSION_MODE: PermissionMode = "auto-approve";

export function isPermissionMode(value: unknown): value is PermissionMode {
  return value === "auto-approve" || value === "ask-each-time";
}

export function readStoredPermissionMode(): PermissionMode {
  if (typeof window === "undefined") {
    return DEFAULT_PERMISSION_MODE;
  }
  const stored = window.localStorage.getItem(PERMISSION_MODE_KEY);
  return isPermissionMode(stored) ? stored : DEFAULT_PERMISSION_MODE;
}
